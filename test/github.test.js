'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { listRepos } = require('../src/github');

test('listRepos exposes the next GitHub page and preserves the previous repos response', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    calls.push(url);
    const page = Number(url.searchParams.get('page'));
    return Response.json([{
      id: page,
      full_name: 'example/repo-' + page,
      name: 'repo-' + page,
      owner: { login: 'example' },
      private: page === 2,
      default_branch: 'trunk',
    }], {
      headers: page === 1
        ? { Link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next", <https://api.github.com/user/repos?per_page=100&page=2>; rel="last"' }
        : { Link: '<https://api.github.com/user/repos?per_page=100&page=1>; rel="prev"' },
    });
  });

  const first = await listRepos('example-token');
  assert.equal(first.nextPage, 2);
  assert.equal(first.repos[0].fullName, 'example/repo-1');

  const second = await listRepos('example-token', first.nextPage);
  assert.equal(second.nextPage, null);
  assert.equal(second.repos[0].fullName, 'example/repo-2');
  assert.equal(second.repos[0].private, true);
  assert.equal(second.repos[0].defaultBranch, 'trunk');
  assert.deepEqual(calls.map(url => url.searchParams.get('page')), ['1', '2']);
  assert.ok(calls.every(url => url.searchParams.get('per_page') === '100'));
});
