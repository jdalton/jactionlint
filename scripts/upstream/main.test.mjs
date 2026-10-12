import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { latestRelease, parseSubmodules, testSkips } from './main.mjs'

const manager = fileURLToPath(new URL('./main.mjs', import.meta.url))

test('parseSubmodules keeps full ref separate from its inline version label', () => {
  const entries = parseSubmodules(`# title\n[submodule "upstream/actionlint"]\n\tpath = upstream/actionlint\n\turl = https://github.com/rhysd/actionlint.git\n\tref = ${'a'.repeat(40)} # v1.7.12\n\tbranch = v1.7.12\n`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].fields.ref, 'a'.repeat(40))
  assert.equal(entries[0].fields.branch, 'v1.7.12')
})

test('latestRelease ignores prereleases and compares semantic versions numerically', () => {
  const result = latestRelease([
    `${'1'.repeat(40)}\trefs/tags/v1.9.0`,
    `${'2'.repeat(40)}\trefs/tags/v1.10.0`,
    `${'3'.repeat(40)}\trefs/tags/v2.0.0-rc.1`,
  ].join('\n'))
  assert.equal(result.tag, 'v1.10.0')
  assert.equal(result.sha, '2'.repeat(40))
})

test('latestRelease resolves annotated tags to their peeled commit SHA', () => {
  const result = latestRelease([
    `${'a'.repeat(40)}\trefs/tags/v1.8.0`,
    `${'b'.repeat(40)}\trefs/tags/v1.8.0^{}`,
  ].join('\n'))
  assert.equal(result.sha, 'b'.repeat(40))
})

test('latestRelease rejects an empty or non-semver tag set', () => {
  assert.throws(() => latestRelease(''), /no stable/)
  assert.throws(() => latestRelease(`${'a'.repeat(40)}\trefs/tags/latest`), /no stable/)
})

test('testSkips records skipped fixture names and reasons from Go JSON events', () => {
  const output = [
    JSON.stringify({ Action: 'output', Test: 'TestCompatibility/example', Output: '    actionlint_compat_test.go:52: shellcheck is not installed\n' }),
    JSON.stringify({ Action: 'skip', Test: 'TestCompatibility/example' }),
  ].join('\n')
  assert.deepEqual(testSkips(output), [{ test: 'TestCompatibility/example', reason: 'actionlint_compat_test.go:52: shellcheck is not installed' }])
})

test('setup pins the requested SHA after a tag moves, keeps the sparse cone, and check recovers interrupted apply offline', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jactionlint-manager-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const remote = path.join(temp, 'remote.git')
  const source = path.join(temp, 'source')
  const root = path.join(temp, 'project')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  execFileSync('git', ['init', '--initial-branch=main', source])
  execFileSync('git', ['-C', source, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `file://${remote}`])
  const sourceFiles = {
    'actionlint.go': 'package actionlint\n',
    'go.mod': 'module example.test/actionlint\n\ngo 1.22\n',
    'go.sum': '',
    'cmd/actionlint.go': 'package main\n',
    'testdata/err/sample.yaml': 'on: push\n',
    'testdata/examples/sample.yaml': 'on: push\n',
    'docs/unneeded.md': 'outside the sparse checkout\n',
  }
  for (const [file, contents] of Object.entries(sourceFiles)) {
    const target = path.join(source, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, 'commit', '-m', 'first source'])
  const pinnedSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.0'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
  await writeFile(path.join(source, 'actionlint.go'), 'package actionlint\n// moved tag\n')
  execFileSync('git', ['-C', source, 'commit', '-am', 'move release tag'])
  const movedSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', '-f', 'v1.0.0'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--force', 'refs/tags/v1.0.0'])

  await mkdir(path.join(root, '.config/repo'), { recursive: true })
  await mkdir(path.join(root, 'scripts/upstream'), { recursive: true })
  execFileSync('git', ['init', root])
  const checksum = '0'.repeat(64)
  const gitmodules = `# actionlint-v1.0.0 sha256:${checksum}\n[submodule "upstream/actionlint"]\n\tpath = upstream/actionlint\n\turl = file://${remote}\n\tignore = dirty\n\tref = ${pinnedSha} # v1.0.0\n\tbranch = v1.0.0\n\tshallow = true\n\tsparse-checkout = /*.go /go.mod /go.sum /cmd/** /testdata/err/** /testdata/examples/**\n`
  const manifest = `${JSON.stringify({ rows: [{ kind: 'version-pin', id: 'actionlint', upstream: 'actionlint', pinned_tag: 'v1.0.0' }] }, null, 2)}\n`
  await writeFile(path.join(root, '.gitmodules'), gitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), manifest)
  const env = {
    ...process.env,
    JACTIONLINT_UPSTREAM_TEST_ROOT: root,
    JACTIONLINT_UPSTREAM_TEST_URL: `file://${remote}`,
    GIT_TERMINAL_PROMPT: '0',
  }
  const run = (...args) => spawnSync(process.execPath, [manager, ...args], { cwd: root, env, encoding: 'utf8' })
  const runAsync = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, ...args], { cwd: root, env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })

  const setup = run('setup')
  assert.equal(setup.status, 0, setup.stderr)
  const checkout = path.join(root, 'upstream/actionlint')
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'HEAD')
  assert.notEqual(pinnedSha, movedSha)
  assert.equal(
    (await readFile(path.join(checkout, 'actionlint.go'), 'utf8')).replace(/\r\n/g, '\n'),
    sourceFiles['actionlint.go'],
  )
  await assert.rejects(readFile(path.join(checkout, 'docs/unneeded.md')))

  const offlineRemote = `${remote}.offline`
  await rename(remote, offlineRemote)
  const offlineSetup = run('setup')
  await rename(offlineRemote, remote)
  assert.equal(offlineSetup.status, 0, offlineSetup.stderr)

  const managerLock = path.join(root, '.git/jactionlint-upstream.lock')
  await mkdir(managerLock)
  await writeFile(path.join(managerLock, 'owner.json'), JSON.stringify({ pid: process.pid }))
  const lockedCheck = run('check')
  assert.notEqual(lockedCheck.status, 0)
  assert.match(lockedCheck.stderr, /another upstream manager command is running/)
  await rm(managerLock, { recursive: true })

  const transactionPath = path.join(root, '.git/jactionlint-upstream-apply.json')
  await writeFile(path.join(checkout, 'actionlint.go'), 'package actionlint\ninterrupted update\n')
  execFileSync('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', movedSha])
  execFileSync('git', ['-C', checkout, 'checkout', '--force', '--detach', movedSha])
  const changedGitmodules = gitmodules.replace('v1.0.0', 'v1.0.1').replace(pinnedSha, movedSha)
  const changedManifest = manifest.replace('v1.0.0', 'v1.0.1')
  await writeFile(path.join(root, '.gitmodules'), changedGitmodules)
  await writeFile(path.join(root, '.config/repo/lockstep.json'), changedManifest)
  await writeFile(transactionPath, JSON.stringify({ gitmodules, manifest, old_sha: pinnedSha, old_tag: 'v1.0.0' }))

  await writeFile(path.join(checkout, 'actionlint.go'), 'preserve local edits\n')
  const refusedRecovery = run('check')
  assert.notEqual(refusedRecovery.status, 0)
  assert.match(refusedRecovery.stderr, /has local changes; refusing recovery/)
  assert.equal(await readFile(path.join(checkout, 'actionlint.go'), 'utf8'), 'preserve local edits\n')
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), changedGitmodules)
  await rm(path.join(checkout, 'actionlint.go'))
  execFileSync('git', ['-C', checkout, 'checkout', '--', 'actionlint.go'])

  const recovered = run('check')
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)
  assert.equal(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'), manifest)
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pinnedSha)
  await assert.rejects(readFile(transactionPath))

  await writeFile(path.join(source, 'actionlint.go'), 'package actionlint\n// reviewed release\n')
  execFileSync('git', ['-C', source, 'commit', '-am', 'reviewed release'])
  const candidateSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', source, 'tag', 'v1.0.1'])
  execFileSync('git', ['-C', source, 'push', 'origin', 'main', '--tags'])
  const archiveBytes = Buffer.from('test archive')
  const server = createServer((request, response) => {
    if (request.url !== '/archive/v1.0.1') { response.writeHead(404).end(); return }
    response.writeHead(200).end(archiveBytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE = `http://127.0.0.1:${address.port}/archive`

  const testInputs = {
    'actionlint_compat_test.go': 'package jactionlint\n',
    'config_helpers_test.go': 'package jactionlint\n',
    'go.mod': 'module example.test/jactionlint\n',
    'go.sum': '',
    'scripts/upstream/main.mjs': await readFile(manager, 'utf8'),
    'testdata/actionlint_originals.txt': 'testdata/err/sample.yaml\n',
    'testdata/err/sample.yaml': 'on: push\n',
    'testdata/err/sample.out': 'expected output\n',
  }
  for (const [file, contents] of Object.entries(testInputs)) {
    const target = path.join(root, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  await mkdir(path.join(root, 'testdata/examples'), { recursive: true })
  const manifestWithTimeout = JSON.parse(manifest)
  manifestWithTimeout.rows[0].verification = { timeout_seconds: 600 }
  const applyManifest = `${JSON.stringify(manifestWithTimeout, null, 2)}\n`
  await writeFile(path.join(root, '.config/repo/lockstep.json'), applyManifest)
  const fakeBin = path.join(temp, 'bin')
  await mkdir(fakeBin)
  const fakeGo = path.join(fakeBin, 'go.mjs')
  const fakeGoOutput = (action) => JSON.stringify({ Action: action, Package: 'example.test/jactionlint', Test: 'TestCorrectnessProfileKeepsEveryErrorOfActionlint/shellcheck' })
  const writeFakeGo = (action) => writeFile(fakeGo, `process.stdout.write(${JSON.stringify(`${fakeGoOutput(action)}\n`)})\n`)
  await writeFakeGo('skip')
  env.JACTIONLINT_UPSTREAM_TEST_GO = JSON.stringify([process.execPath, fakeGo])

  const skippedApply = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.notEqual(skippedApply.status, 0)
  assert.notEqual(skippedApply.stdout, '', skippedApply.stderr)
  const skippedReceipt = JSON.parse(skippedApply.stdout).verification
  assert.equal(skippedReceipt.passed, false)
  assert.equal(skippedReceipt.skipped_coverage.length, 1)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), gitmodules)
  assert.equal(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'), applyManifest)

  await writeFakeGo('pass')
  const malformedGitmodules = gitmodules.replace('\tbranch = v1.0.0', '\tbranch=v1.0.0')
  await writeFile(path.join(root, '.gitmodules'), malformedGitmodules)
  const metadataReject = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.notEqual(metadataReject.status, 0)
  assert.match(metadataReject.stderr, /could not update each expected \.gitmodules entry exactly once/)
  assert.equal(await readFile(path.join(root, '.gitmodules'), 'utf8'), malformedGitmodules)
  assert.equal(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'), applyManifest)
  await writeFile(path.join(root, '.gitmodules'), gitmodules)

  const applied = await runAsync('update', '--apply', 'v1.0.1', candidateSha, '--accept-reviewed')
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), new RegExp(`ref = ${candidateSha} # v1\\.0\\.1`))
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), /branch = v1\.0\.1/)
  const archiveSha = createHash('sha256').update(archiveBytes).digest('hex')
  assert.match(await readFile(path.join(root, '.gitmodules'), 'utf8'), new RegExp(`sha256:${archiveSha}`))
  assert.equal(JSON.parse(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8')).rows[0].pinned_tag, 'v1.0.1')
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), candidateSha)

  await rm(remote, { recursive: true, force: true })
  const offlineCheck = run('check')
  assert.equal(offlineCheck.status, 0, offlineCheck.stderr)
  await writeFile(path.join(checkout, 'actionlint.go'), 'dirty\n')
  const dirtyCheck = run('check')
  assert.notEqual(dirtyCheck.status, 0)
  assert.match(dirtyCheck.stderr, /does not match its accepted pin/)
})
