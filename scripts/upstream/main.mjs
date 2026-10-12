#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(process.env.JACTIONLINT_UPSTREAM_TEST_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const repo = {
  name: 'actionlint', path: 'upstream/actionlint',
  url: process.env.JACTIONLINT_UPSTREAM_TEST_URL ?? 'https://github.com/rhysd/actionlint.git',
  archive: process.env.JACTIONLINT_UPSTREAM_TEST_ARCHIVE ?? 'https://codeload.github.com/rhysd/actionlint/tar.gz/refs/tags',
}
const sparsePaths = ['/*.go', '/go.mod', '/go.sum', '/cmd/**', '/testdata/err/**', '/testdata/examples/**']
const verificationInputs = ['actionlint_compat_test.go', 'config_helpers_test.go', 'go.mod', 'go.sum', 'scripts/upstream/main.mjs', 'testdata/actionlint_originals.txt']
const testName = 'TestCorrectnessProfileKeepsEveryErrorOfActionlint'

export function parseSubmodules(text) {
  const blocks = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[submodule\s+"([^"]+)"\]\s*$/.exec(line)
    if (header) {
      if (current) blocks.push(current)
      current = { name: header[1], fields: Object.create(null), lines: [] }
    } else if (current) {
      current.lines.push(line)
      const field = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (field) current.fields[field[1]] = field[2].replace(/\s+#.*$/, '')
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function git(args, cwd = root, inherit = false) {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' })
  return typeof output === 'string' ? output.trim() : ''
}

async function readPin() {
  const text = await readFile(path.join(root, '.gitmodules'), 'utf8')
  const entry = parseSubmodules(text).find(block => block.fields.path === repo.path)
  if (!entry) throw new Error(`.gitmodules has no ${repo.path} entry`)
  const { ref, branch, shallow, url } = entry.fields
  const refLine = entry.lines.find(line => /^\s*ref\s*=/.test(line)) ?? ''
  const label = /#\s*(v\d+\.\d+\.\d+)\s*$/.exec(refLine)?.[1]
  const section = text.split(/\r?\n/)
  const headerIndex = section.findIndex(line => line.trim() === `[submodule "${entry.name}"]`)
  const integrityMatch = /^#\s*actionlint-(v\d+\.\d+\.\d+) sha256:([0-9a-f]{64})$/.exec(section[headerIndex - 1]?.trim() ?? '')
  const integrity = integrityMatch?.[2]
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) throw new Error(`${repo.path} ref must be a full commit SHA`)
  if (!/^v\d+\.\d+\.\d+$/.test(branch ?? '') || !label || branch !== label) throw new Error(`${repo.path} branch must match its release-tag ref comment`)
  if (shallow !== 'true') throw new Error(`${repo.path} must set shallow = true`)
  if ((entry.fields['sparse-checkout'] ?? '').split(/\s+/).join('\n') !== sparsePaths.join('\n')) throw new Error(`${repo.path} sparse-checkout must match the declared source and fixture paths`)
  if (!integrity || integrityMatch[1] !== label) throw new Error(`${repo.path} needs a matching archive sha256 comment immediately above its submodule block`)
  if (url !== repo.url) throw new Error(`${repo.path} URL differs from the declared upstream`)
  const manifest = JSON.parse(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'))
  const row = manifest.rows.find(item => item.kind === 'version-pin' && item.id === repo.name)
  if (!row || row.upstream !== repo.name || row.pinned_tag !== label || 'pinned_sha' in row) throw new Error('lockstep row must match the upstream pin label and derive its SHA from .gitmodules')
  return { text, entry, ref, tag: label, integrity }
}

function gitDir(dir) {
  return path.resolve(dir, git(['-C', dir, 'rev-parse', '--git-dir']))
}

function repositoryGitDir() {
  return path.resolve(root, git(['rev-parse', '--git-dir']))
}

function isGitRepo(dir) {
  try { git(['-C', dir, 'rev-parse', '--git-dir']); return true } catch { return false }
}

async function sparse(dir) {
  git(['-C', dir, 'config', 'core.sparseCheckout', 'true'])
  git(['-C', dir, 'config', 'core.sparseCheckoutCone', 'false'])
  await writeFile(path.join(gitDir(dir), 'info/sparse-checkout'), `${sparsePaths.join('\n')}\n`)
}

async function materialize(dir, sha) {
  if (isGitRepo(dir)) {
    const dirty = git(['-C', dir, 'status', '--porcelain'])
    if (dirty) throw new Error(`${dir} has local changes; refusing to update the reference checkout`)
    if (git(['-C', dir, 'remote', 'get-url', 'origin']) !== repo.url) throw new Error(`${dir} origin URL differs from ${repo.url}`)
  } else {
    git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', repo.url, dir], root, true)
  }
  await sparse(dir)
  const head = isGitRepo(dir) ? git(['-C', dir, 'rev-parse', 'HEAD']) : ''
  if (head !== sha) {
    try { git(['-C', dir, 'cat-file', '-e', `${sha}^{commit}`]) }
    catch { git(['-C', dir, 'fetch', '--depth', '1', 'origin', sha], root, true) }
  }
  git(['-C', dir, 'checkout', '--force', '--detach', sha], root, true)
  git(['-C', dir, 'read-tree', '-mu', 'HEAD'])
  const actual = git(['-C', dir, 'rev-parse', 'HEAD'])
  if (actual !== sha) throw new Error(`materialized ${actual}; expected ${sha}`)
}

export async function check() {
  const pin = await readPin()
  const dir = path.join(root, repo.path)
  if (!isGitRepo(dir)) throw new Error(`missing ${dir}; run mise run setup:upstream`)
  const head = git(['-C', dir, 'rev-parse', 'HEAD'])
  const patterns = await readFile(path.join(gitDir(dir), 'info/sparse-checkout'), 'utf8')
  if (head !== pin.ref || patterns.trim() !== sparsePaths.join('\n') || git(['-C', dir, 'status', '--porcelain'])) throw new Error(`${repo.path} does not match its accepted pin/sparse paths or has local changes; run mise run setup:upstream`)
  console.log(`${repo.name} ${pin.tag} ${head}: current`)
}

function version(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return match ? match.slice(1).map(Number) : null
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function latestRelease(output) {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const peeled = new Map(lines.flatMap(line => {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)\^\{\}$/.exec(line)
    return match ? [[match[2], match[1]]] : []
  }))
  const releases = lines.map(line => {
    const [sha, ref] = line.split(/\s+/)
    if (ref.endsWith('^{}')) return null
    const tag = ref.replace('refs/tags/', '')
    const parsed = version(tag)
    const commit = peeled.get(tag) ?? sha
    return parsed && /^[0-9a-f]{40}$/.test(commit) ? { sha: commit, tag, version: parsed } : null
  }).filter(Boolean).sort((a, b) => compareVersion(a.version, b.version))
  if (!releases.length) throw new Error('no stable vMAJOR.MINOR.PATCH tags found')
  return releases.at(-1)
}

function releaseFromRemote() {
  return latestRelease(git(['ls-remote', '--tags', repo.url]))
}

async function hashArchive(tag) {
  const hash = createHash('sha256')
  const response = await new Promise((resolve, reject) => {
    const client = repo.archive.startsWith('http://') ? http : https
    const request = client.get(`${repo.archive}/${tag}`, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`archive request returned HTTP ${res.statusCode}`)); return }
      resolve(res)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('archive request timed out after 30 seconds')))
    request.on('error', reject)
  })
  response.on('data', chunk => hash.update(chunk))
  await new Promise((resolve, reject) => response.on('end', resolve).on('error', reject))
  return hash.digest('hex')
}

function classify(files) {
  return files.map(file => {
    if (file.startsWith('testdata/err/') || file.startsWith('testdata/examples/')) return { file, classification: 'fixture' }
    if (/^(docs\/|README|CHANGELOG|LICENSE|\.github\/|.*\.(go|mod|sum|yml|yaml|json|md))/.test(file)) return { file, classification: 'source-review-required' }
    return { file, classification: 'unmapped' }
  })
}

function changedFiles(dir, oldSha, newSha) {
  git(['-C', dir, 'fetch', '--depth', '1', 'origin', oldSha], root, true)
  return git(['-C', dir, 'diff', '--name-only', `${oldSha}..${newSha}`], root).split(/\r?\n/).filter(Boolean)
}

async function digestInputs() {
  const hash = createHash('sha256')
  const files = [...verificationInputs]
  for (const file of (await readFile(path.join(root, 'testdata/actionlint_originals.txt'), 'utf8')).split(/\r?\n/).filter(Boolean)) {
    files.push(file, file.replace(/\.yaml$/, '.out'))
  }
  for (const dir of ['testdata/err', 'testdata/examples']) {
    for (const name of await readdir(path.join(root, dir))) if (name.endsWith('.config')) files.push(path.join(dir, name))
  }
  for (const file of files.sort()) hash.update(file).update(await readFile(path.join(root, file)))
  return { count: files.length, digest: hash.digest('hex') }
}

export function testSkips(output) {
  const logs = new Map()
  const skips = []
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.Test && event.Action === 'output') logs.set(event.Test, `${logs.get(event.Test) ?? ''}${event.Output ?? ''}`)
    if (event.Test && event.Action === 'skip') skips.push({ test: event.Test, reason: (logs.get(event.Test) ?? '').trim() })
  }
  return skips
}

async function verifyCandidate(sha, tag, candidateDir) {
  const pin = await readPin()
  await materialize(candidateDir, sha, tag)
  const changes = classify(changedFiles(candidateDir, pin.ref, sha))
  const manifest = JSON.parse(await readFile(path.join(root, '.config/repo/lockstep.json'), 'utf8'))
  const timeoutSeconds = manifest.rows.find(item => item.kind === 'version-pin' && item.id === repo.name)?.verification?.timeout_seconds
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('lockstep verification timeout_seconds must be a positive integer')
  const [goCommand, ...goArgs] = process.env.JACTIONLINT_UPSTREAM_TEST_GO
    ? JSON.parse(process.env.JACTIONLINT_UPSTREAM_TEST_GO)
    : ['go']
  const result = spawnSync(goCommand, [...goArgs, 'test', '-json', '-v', '-run', `^${testName}$`, '.'], {
    cwd: root, encoding: 'utf8', timeout: timeoutSeconds * 1000,
  })
  const inputs = await digestInputs()
  const failed = result.status !== 0 || result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const skippedCoverage = testSkips(result.stdout ?? '')
  return {
    version: 1, accepted_sha: pin.ref, candidate_sha: sha, candidate_tag: tag,
    changed_files: changes,
    verification_input_patterns: [...verificationInputs, 'testdata/err/*.config', 'testdata/err/*.yaml', 'testdata/err/*.out', 'testdata/examples/*.config', 'testdata/examples/*.yaml', 'testdata/examples/*.out'],
    verification_input_count: inputs.count, verification_input_digest: inputs.digest,
    verification_scope: 'local curated compatibility corpus; candidate upstream changes are listed and review-gated',
    checks: [{ command: `go test -json -v -run ^${testName}$ .`, status: failed ? 'failed' : skippedCoverage.length ? 'incomplete' : 'passed', ...(failed ? { output } : {}) }],
    skipped_coverage: skippedCoverage, unknown: changes.filter(item => item.classification === 'unmapped'),
    source_review_required: changes.filter(item => item.classification === 'source-review-required'),
    review_required: changes.length > 0,
    passed: !failed && skippedCoverage.length === 0 && changes.every(item => item.classification !== 'unmapped'),
  }
}

async function update(args) {
  const pin = await readPin()
  const target = releaseFromRemote()
  if (compareVersion(target.version, version(pin.tag)) < 0) throw new Error(`latest tag ${target.tag} would downgrade ${pin.tag}`)
  if (args[0] === '--apply') {
    if (args.length !== 4 || args[3] !== '--accept-reviewed') throw new Error('apply requires: update --apply <tag> <candidate-sha> --accept-reviewed')
    if (args[1] !== target.tag) throw new Error(`requested ${args[1]}, current latest release is ${target.tag}; rerun mise run update:upstream`)
    if (args[2] !== target.sha) throw new Error(`candidate SHA changed since review; expected ${args[2]}, current tag resolves to ${target.sha}`)
    if (pin.ref === target.sha) throw new Error(`${target.tag} is already the accepted pin; there is nothing to apply`)
    const accepted = path.join(root, repo.path)
    if (!isGitRepo(accepted)) throw new Error(`missing ${accepted}; run mise run setup:upstream before applying an update`)
    if (git(['-C', accepted, 'remote', 'get-url', 'origin']) !== repo.url) throw new Error(`${accepted} origin URL differs from ${repo.url}`)
    if (git(['-C', accepted, 'status', '--porcelain'])) throw new Error(`${accepted} has local changes; refusing to start an update transaction`)
    if (git(['-C', accepted, 'rev-parse', 'HEAD']) !== pin.ref) throw new Error(`${accepted} does not match the accepted pin; run mise run setup:upstream before applying an update`)
  }
  const sha256 = await hashArchive(target.tag)
  if (target.sha === pin.ref && sha256 !== pin.integrity) throw new Error(`archive hash for accepted ${pin.tag} differs from its recorded checksum`)
  const plan = { current: { sha: pin.ref, tag: pin.tag }, candidate: { sha: target.sha, tag: target.tag, sha256 } }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jactionlint-upstream-'))
  try {
    const receipt = await verifyCandidate(target.sha, target.tag, path.join(temp, repo.name))
    console.log(JSON.stringify({ ...plan, verification: receipt }, null, 2))
    if (args[0] !== '--apply') return
    if (!receipt.passed) throw new Error('candidate verification failed or has unmapped changes; accepted pin unchanged')
    if ((await digestInputs()).digest !== receipt.verification_input_digest) throw new Error('verification inputs changed after candidate review; rerun mise run update:upstream')
    const edits = [
      [`# ${repo.name}-${pin.tag} sha256:${pin.integrity}`, `# ${repo.name}-${target.tag} sha256:${sha256}`],
      [`ref = ${pin.ref} # ${pin.tag}`, `ref = ${target.sha} # ${target.tag}`],
      [`branch = ${pin.tag}`, `branch = ${target.tag}`],
    ]
    let updated = pin.text
    for (const [from, to] of edits) {
      const first = updated.indexOf(from)
      if (first < 0 || updated.indexOf(from, first + from.length) >= 0) throw new Error('could not update each expected .gitmodules entry exactly once; accepted pin unchanged')
      updated = `${updated.slice(0, first)}${to}${updated.slice(first + from.length)}`
    }
    const gm = path.join(root, '.gitmodules')
    const manifestPath = path.join(root, '.config/repo/lockstep.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const row = manifest.rows.find(item => item.kind === 'version-pin' && item.id === repo.name)
    if (!row) throw new Error(`lockstep manifest has no ${repo.name} version-pin row`)
    row.pinned_tag = target.tag
    const manifestUpdated = `${JSON.stringify(manifest, null, 2)}\n`
    const transactionPath = path.join(repositoryGitDir(), 'jactionlint-upstream-apply.json')
    const transaction = {
      gitmodules: await readFile(gm, 'utf8'), manifest: await readFile(manifestPath, 'utf8'),
      old_sha: pin.ref, old_tag: pin.tag,
    }
    await writeFile(`${transactionPath}.tmp`, `${JSON.stringify(transaction)}\n`)
    await rename(`${transactionPath}.tmp`, transactionPath)
    try {
      await atomicWrite(gm, updated)
      await atomicWrite(manifestPath, manifestUpdated)
      await materialize(path.join(root, repo.path), target.sha)
      await rm(transactionPath, { force: true })
    } catch (error) {
      try { await recoverInterruptedApply() }
      catch (recoveryError) { throw new Error(`${error.message}; upstream apply recovery failed: ${recoveryError.message}`) }
      throw error
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

async function recoverInterruptedApply() {
  const transactionPath = path.join(repositoryGitDir(), 'jactionlint-upstream-apply.json')
  let transaction
  try { transaction = JSON.parse(await readFile(transactionPath, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return
    throw new Error(`cannot read upstream apply recovery record at ${transactionPath}: ${error.message}`)
  }
  if (typeof transaction.gitmodules !== 'string' || typeof transaction.manifest !== 'string' || !/^[0-9a-f]{40}$/.test(transaction.old_sha ?? '') || !/^v\d+\.\d+\.\d+$/.test(transaction.old_tag ?? '')) {
    throw new Error(`upstream apply recovery record at ${transactionPath} is invalid`)
  }
  const dir = path.join(root, repo.path)
  if (isGitRepo(dir)) {
    if (git(['-C', dir, 'remote', 'get-url', 'origin']) !== repo.url) throw new Error(`${dir} origin URL differs from ${repo.url}; refusing recovery`)
    if (git(['-C', dir, 'status', '--porcelain'])) throw new Error(`${dir} has local changes; refusing recovery and preserving the checkout`)
  }
  await atomicWrite(path.join(root, '.gitmodules'), transaction.gitmodules)
  await atomicWrite(path.join(root, '.config/repo/lockstep.json'), transaction.manifest)
  if (isGitRepo(dir)) {
    await materialize(dir, transaction.old_sha)
  } else {
    await materialize(dir, transaction.old_sha)
  }
  await rm(transactionPath, { force: true })
}

async function withLock(action) {
  const lockPath = path.join(repositoryGitDir(), 'jactionlint-upstream.lock')
  for (;;) {
    try {
      await mkdir(lockPath)
      await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid })}\n`)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) }
      catch { throw new Error(`another upstream manager command is starting or the lock needs manual cleanup (lock: ${lockPath})`) }
      let alive = true
      try { process.kill(owner.pid, 0) }
      catch (signalError) { if (signalError.code === 'ESRCH') alive = false }
      if (alive) throw new Error(`another upstream manager command is running (pid ${owner.pid}; lock: ${lockPath})`)
      await rm(lockPath, { recursive: true, force: true })
    }
  }
  try { return await action() }
  finally { await rm(lockPath, { recursive: true, force: true }) }
}

async function main(argv) {
  await withLock(async () => {
    await recoverInterruptedApply()
    const [command, ...args] = argv
    if (command === 'setup') {
      const pin = await readPin()
      await materialize(path.join(root, repo.path), pin.ref)
    } else if (command === 'check') await check()
    else if (command === 'update' && (args.length === 0 || args[0] === '--plan')) await update([])
    else if (command === 'update' && args[0] === '--apply') await update(args)
    else throw new Error('usage: mise run <setup:upstream|check:upstream|update:upstream>')
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`upstream: ${error.message}`); process.exitCode = 1 })
}
