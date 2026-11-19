'use strict';

const fs = require('fs');
const path = require('path');

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Inspeciona um projeto já extraído em disco e decide como ele deve rodar.
 * Retorna metadados usados pelo app e pelo runner.
 */
function detectProjectType(dir) {
  const hasIndexHtml = isFile(path.join(dir, 'index.html'));
  const pkg = readJson(path.join(dir, 'package.json'));

  if (pkg) {
    const scripts = pkg.scripts || {};
    let startCommand = null;
    if (typeof scripts.start === 'string' && scripts.start.trim()) {
      startCommand = 'npm start';
    } else {
      const candidates = [pkg.main, 'server.js', 'app.js', 'index.js']
        .filter(c => typeof c === 'string' && c.trim())
        .map(c => c.replace(/^\.\//, ''));
      const entry = candidates.find(c => isFile(path.join(dir, c)));
      if (entry) startCommand = `node ${entry}`;
    }
    return {
      type: 'node',
      docroot: '',
      startCommand,
      hasBuild: typeof scripts.build === 'string' && scripts.build.trim().length > 0,
      hasIndexHtml,
      hasPackage: true,
      hasPhp: false,
    };
  }

  const hasPublicIndexPhp = isFile(path.join(dir, 'public', 'index.php'));
  const hasRootIndexPhp = isFile(path.join(dir, 'index.php'));
  let rootPhp = [];
  try {
    rootPhp = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.php'));
  } catch {
    rootPhp = [];
  }
  const hasComposer = isFile(path.join(dir, 'composer.json'));
  const hasPhp = hasRootIndexPhp || hasPublicIndexPhp || rootPhp.length > 0 || hasComposer;

  if (hasPhp) {
    return {
      type: 'php',
      // Frameworks como Laravel/Symfony expõem o front controller em public/.
      docroot: hasPublicIndexPhp ? 'public' : '',
      startCommand: null,
      hasBuild: false,
      hasIndexHtml,
      hasPackage: false,
      hasPhp: true,
    };
  }

  return {
    type: 'static',
    docroot: '',
    startCommand: null,
    hasBuild: false,
    hasIndexHtml,
    hasPackage: false,
    hasPhp: false,
  };
}

module.exports = { detectProjectType };