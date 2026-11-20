'use strict';

// ---------------------------------------------------------------------------
// Limpeza e otimização do Docker do host.
//
// Política (configurável):
//   - Contêineres parados há mais de CLEANUP_GRACE_HOURS (padrão 24h) são
//     removidos. Antes disso o dono recebe um aviso no painel.
//   - Imagens não utilizadas por nenhum contêiner, com mais de 24h, idem.
//   - Volumes órfãos (dangling) idem.
//   - `docker system prune -a -f` (ação administrativa) calcula o impacto,
//     avisa cada usuário afetado com o motivo e só então executa (se forçado).
// ---------------------------------------------------------------------------

const docker = require('./docker-runtime');

const GRACE_HOURS = Number(process.env.CLEANUP_GRACE_HOURS || 24);
const GRACE_MS = GRACE_HOURS * 3600 * 1000;

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function fmtDate(date) {
  try {
    return new Date(date).toLocaleString('pt-BR');
  } catch {
    return String(date);
  }
}

async function projectByComposeName(pool, composeProject) {
  if (!composeProject || !composeProject.startsWith('hostfy-')) return null;
  const slug = composeProject.slice('hostfy-'.length);
  const { rows } = await pool.query('SELECT id, user_id, slug, name FROM projects WHERE slug=$1', [slug]);
  return rows[0] || null;
}

async function upsertCandidate(pool, c) {
  const { rows } = await pool.query(
    `INSERT INTO cleanup_candidates
       (kind, resource_id, name, project_id, owner_id, reason, detail, size_bytes, scheduled_for, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
     ON CONFLICT (kind, resource_id) WHERE status NOT IN ('executed','skipped')
     DO UPDATE SET reason=EXCLUDED.reason, scheduled_for=EXCLUDED.scheduled_for,
                   name=EXCLUDED.name, detail=EXCLUDED.detail, size_bytes=EXCLUDED.size_bytes
     RETURNING *`,
    [
      c.kind, c.resourceId, c.name || null, c.projectId || null, c.ownerId || null,
      c.reason || null, JSON.stringify(c.detail || {}), c.sizeBytes || null, c.scheduledFor || null,
    ]
  );
  return rows[0];
}

async function notify(pool, { userId, projectId, level, title, body, action, meta, dedupeKey }) {
  if (!userId) return;
  await pool.query(
    `INSERT INTO notifications (user_id, project_id, level, title, body, action, meta, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId, projectId || null, level || 'info', title, body || null, action || null, JSON.stringify(meta || {}), dedupeKey || null]
  );
}

async function markNotified(pool, id) {
  await pool.query(`UPDATE cleanup_candidates SET status='notified', notified_at=NOW() WHERE id=$1 AND notified_at IS NULL`, [id]);
}

// Analisa o host e registra avisos + candidatos a limpeza. Não remove nada.
async function scan(pool) {
  const report = { containers: [], images: [], volumes: [], notified: 0 };
  const now = Date.now();

  // ---- Contêineres parados ----
  for (const c of await docker.stoppedContainers().catch(() => [])) {
    if (!c.finishedAt) continue;
    const finished = new Date(c.finishedAt).getTime();
    if (!Number.isFinite(finished)) continue;
    const ageHours = (now - finished) / 3600000;
    const scheduledFor = new Date(finished + GRACE_MS);
    const project = await projectByComposeName(pool, c.project);
    const owner = project ? project.name : 'o host';
    const reason = `Contêiner "${c.name}" (imagem ${c.image}) parado há ${ageHours.toFixed(1)}h — projeto ${owner}.`;
    const cand = await upsertCandidate(pool, {
      kind: 'container', resourceId: c.id, name: c.name,
      projectId: project ? project.id : null, ownerId: project ? project.user_id : null,
      reason, detail: { image: c.image, state: c.state, service: c.service },
      scheduledFor,
    });
    if (project && !cand.notified_at) {
      await notify(pool, {
        userId: project.user_id, projectId: project.id, level: 'warning',
        title: `Contêiner parado será removido em ${GRACE_HOURS}h`,
        body: `${reason}\n\nA limpeza automática do Docker removerá este contêiner em ${fmtDate(scheduledFor)}. Faça um novo deploy para mantê-lo.`,
        action: 'cleanup',
        meta: { kind: 'container', resourceId: c.id },
        dedupeKey: `cleanup:container:${c.id}`,
      });
      await markNotified(pool, cand.id);
      report.notified += 1;
    }
    report.containers.push({ ...c, ageHours: Number(ageHours.toFixed(2)), due: now >= scheduledFor.getTime(), scheduledFor });
  }

  // ---- Imagens não utilizadas ----
  for (const img of await docker.unusedImages().catch(() => [])) {
    const created = img.createdAt ? new Date(img.createdAt).getTime() : now;
    if (!Number.isFinite(created)) continue;
    const ageHours = (now - created) / 3600000;
    const scheduledFor = new Date(created + GRACE_MS);
    const reason = `Imagem "${img.name}" sem contêiner associado há ${ageHours.toFixed(1)}h (${fmtBytes(img.bytes)}).`;
    const cand = await upsertCandidate(pool, {
      kind: 'image', resourceId: img.id, name: img.name,
      reason, detail: { bytes: img.bytes }, sizeBytes: img.bytes, scheduledFor,
    });
    report.images.push({ ...img, ageHours: Number(ageHours.toFixed(2)), due: now >= scheduledFor.getTime(), scheduledFor });
    void cand;
  }

  // ---- Volumes órfãos ----
  for (const vol of await docker.unusedVolumes().catch(() => [])) {
    const created = vol.createdAt ? new Date(vol.createdAt).getTime() : now;
    const ageHours = (now - created) / 3600000;
    const scheduledFor = new Date(created + GRACE_MS);
    const project = await projectByComposeName(pool, vol.project);
    const owner = project ? project.name : 'o host';
    const reason = `Volume órfão "${vol.name}" sem uso há ${ageHours.toFixed(1)}h — projeto ${owner}.`;
    const cand = await upsertCandidate(pool, {
      kind: 'volume', resourceId: vol.name, name: vol.name,
      projectId: project ? project.id : null, ownerId: project ? project.user_id : null,
      reason, detail: {}, scheduledFor,
    });
    if (project && !cand.notified_at) {
      await notify(pool, {
        userId: project.user_id, projectId: project.id, level: 'warning',
        title: `Volume órfão será removido em ${GRACE_HOURS}h`,
        body: `${reason}\n\nA limpeza automática removerá este volume em ${fmtDate(scheduledFor)}.`,
        action: 'cleanup',
        meta: { kind: 'volume', resourceId: vol.name },
        dedupeKey: `cleanup:volume:${vol.name}`,
      });
      await markNotified(pool, cand.id);
      report.notified += 1;
    }
    report.volumes.push({ ...vol, ageHours: Number(ageHours.toFixed(2)), due: now >= scheduledFor.getTime(), scheduledFor });
  }

  return report;
}

// Executa a remoção dos candidatos cujo prazo já venceu.
async function runDue(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM cleanup_candidates
      WHERE status NOT IN ('executed','skipped') AND scheduled_for IS NOT NULL AND scheduled_for <= NOW()
      ORDER BY scheduled_for ASC`
  );
  const executed = [];
  for (const cand of rows) {
    try {
      if (cand.kind === 'container') await docker.removeContainer(cand.resource_id);
      else if (cand.kind === 'image') await docker.removeImage(cand.resource_id);
      else if (cand.kind === 'volume') await docker.removeVolume(cand.resource_id);
      await pool.query(`UPDATE cleanup_candidates SET status='executed', executed_at=NOW() WHERE id=$1`, [cand.id]);
      executed.push({ kind: cand.kind, name: cand.name });
      if (cand.owner_id) {
        await notify(pool, {
          userId: cand.owner_id, projectId: cand.project_id, level: 'info',
          title: 'Limpeza do Docker concluída',
          body: `Removido ${cand.kind === 'container' ? 'o contêiner' : cand.kind === 'image' ? 'a imagem' : 'o volume'} "${cand.name}". Motivo: ${cand.reason}`,
          action: 'cleanup',
          dedupeKey: `cleanup-done:${cand.kind}:${cand.resource_id}:${cand.id}`,
        });
      }
    } catch (e) {
      // Mantém o candidato pendente para nova tentativa na próxima execução.
      await pool.query(`UPDATE cleanup_candidates SET detail = detail || $2, status='pending' WHERE id=$1`, [
        cand.id,
        JSON.stringify({ lastError: e.message }),
      ]);
    }
  }
  return { executed, considered: rows.length };
}

// Calcula o impacto de um `docker system prune -a -f` e avisa os usuários.
async function pruneImpact(pool, { volumes = false } = {}) {
  const containers = await docker.stoppedContainers().catch(() => []);
  const images = await docker.unusedImages().catch(() => []);
  const vols = volumes ? await docker.unusedVolumes().catch(() => []) : [];
  const byUser = new Map();

  for (const c of containers) {
    const project = await projectByComposeName(pool, c.project);
    if (!project) continue;
    const item = byUser.get(project.user_id) || { project, items: [] };
    item.items.push(`Contêiner parado "${c.name}" do projeto "${project.name}"`);
    byUser.set(project.user_id, item);
  }

  let notified = 0;
  for (const { project, items } of byUser.values()) {
    notified += 1;
    await notify(pool, {
      userId: project.user_id, projectId: project.id, level: 'warning',
      title: 'Manutenção do Docker pode remover recursos do seu projeto',
      body: `O administrador iniciou uma limpeza completa (docker system prune -a -f). Os itens abaixo podem ser descartados:\n\n- ${items.join('\n- ')}\n\nMotivo: o recurso está sem uso. Faça um novo deploy para recriá-lo.`,
      action: 'cleanup',
      meta: { prune: true, volumes },
      dedupeKey: `prune:${Date.now()}`,
    });
  }

  return {
    containers: containers.map(c => ({ id: c.id, name: c.name, project: c.project, reason: c.finishedAt ? `parado desde ${c.finishedAt}` : 'parado' })),
    images: images.map(i => ({ id: i.id, name: i.name, size: fmtBytes(i.bytes) })),
    volumes: vols.map(v => ({ name: v.name, project: v.project })),
    reclaimable: {
      containers: containers.length,
      images: images.length,
      volumes: vols.length,
      imageBytes: images.reduce((a, i) => a + (i.bytes || 0), 0),
    },
    affectedUsers: notified,
  };
}

module.exports = { scan, runDue, pruneImpact, GRACE_HOURS, fmtBytes };