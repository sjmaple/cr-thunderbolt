/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { lintReproSpec, type RawFinding } from './findings'
import type { TranscriptMessage } from './report'
import {
  judge,
  replay,
  replayEnv,
  screenshotTaken,
  worstJudgeCost,
  type CreateMessage,
  type ReplayReport,
  type RunReplay,
  type Verified,
} from './verify'

const validSpec = (title: string) => `import { expect, test } from '@playwright/test'
import { loginViaEmailCode } from '../../../e2e/helpers'

test('${title}', async ({ page }) => {
  await loginViaEmailCode(page)
  await expect(page.getByText('${title}')).toBeVisible()
})
`

const makeFinding = (title: string, oracle: RawFinding['oracle']): RawFinding & { repro_spec: string } => ({
  title,
  area: 'chat',
  charter: 'c2-chat',
  viewport: 'desktop',
  oracle,
  steps: ['Open the chat', 'Send a message'],
  expected: 'The reply appears',
  actual: 'Nothing happens',
  repro_spec: `repro/${title}.spec.ts`,
})

const pageError = { type: 'page-error', evidence: 'TypeError: messages is undefined' }

const shotFile = 'page-2026-10-19T16-08-14-750Z.png'

/** A visual finding: a screenshot under the session's `mcp/` instead of a repro spec. */
const makeVisual = (title: string, screenshot = `mcp/${shotFile}`): RawFinding => ({
  ...makeFinding(title, { type: 'visual', evidence: 'The send button sits under the composer toolbar' }),
  area: 'layout',
  element: 'button "Send"',
  function: 'chat-send',
  screenshot,
  repro_spec: undefined,
})

/**
 * What Playwright MCP 0.0.83 returns for `browser_take_screenshot` without a filename, run with
 * `--file-paths absolute`; transcript.json keeps the text block only, not the image.
 */
const screenshotResult = (dir: string, file = shotFile) =>
  `### Result\n- [Screenshot of viewport](${dir}/${file})\n### Ran Playwright code\n\`\`\`js\n` +
  `// Screenshot viewport and save it as ${dir}/${file}\nawait page.screenshot({\n  path: '${dir}/${file}',\n` +
  `  scale: 'css',\n  type: 'png'\n});\n\`\`\`\n### Events\n` +
  `- New console entries: ${dir}/console-2026-10-19T16-08-14-157Z.log#L2`
const sessionDir = '/home/runner/work/thunderbolt/thunderbolt/qa-out/c2-chat'

const callsOf = (steps: (readonly [string, string])[]): TranscriptMessage[] =>
  steps.flatMap(([name, result], i) => [
    { message: { content: [{ type: 'tool_use' as const, id: `t${i}`, name }] } },
    { message: { content: [{ type: 'tool_result' as const, tool_use_id: `t${i}`, content: result }] } },
  ])

/** The start of a PNG of that size: its signature and IHDR chunk, all the screenshot checks read. */
const pngOf = (width: number, height: number) => {
  const ihdr = Buffer.alloc(8)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), ihdr])
}

/**
 * The start of a JPEG of that size: SOI, an APP0 and a DHT segment to skip (DHT's marker, C4, sits among the
 * frame-header markers), then the SOF0 frame header.
 */
const jpegOf = (width: number, height: number) => {
  const sof = Buffer.from('ffc0001108000000000301', 'hex')
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  const app0 = 'ffe000104a46494600010100000100010000'
  const dht = 'ffc4000900000000000000'
  return Buffer.concat([Buffer.from(`ffd8${app0}${dht}`, 'hex'), sof])
}

const pngBytes = pngOf(1280, 800)

let outDir: string
let qaDir: string

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'qa-verify-out-'))
  qaDir = await mkdtemp(join(tmpdir(), 'qa-verify-qa-'))
  await Bun.write(join(qaDir, 'noise.txt'), '# header\n\n  ResizeObserver loop  \n')
  await Bun.write(join(qaDir, 'judge.md'), 'JUDGE PROMPT')
  await Bun.write(join(qaDir, 'known-issues.md'), 'KNOWN ISSUES')
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
  await rm(qaDir, { recursive: true, force: true })
})

/** Writes `c2-chat/findings/<title>.json` and, unless `spec` is null, its repro spec. */
const writeFinding = async (finding: RawFinding, spec: string | null = validSpec(finding.title)) => {
  await Bun.write(join(outDir, 'c2-chat/findings', `${finding.title}.json`), JSON.stringify(finding))
  if (spec !== null && finding.repro_spec) await Bun.write(join(outDir, 'c2-chat', finding.repro_spec), spec)
}

/** Writes c2-chat's transcript with the given tool calls, and the screenshot file `mcp/<shotFile>`. */
const writeSession = async (steps: (readonly [string, string])[]) => {
  await Bun.write(join(outDir, 'c2-chat/transcript.json'), JSON.stringify(callsOf(steps)))
  await Bun.write(join(outDir, 'c2-chat/mcp', shotFile), pngBytes)
}

const controlSpec = () => join(qaDir, 'control/stack.spec.ts')

/**
 * A runner that reports the given result statuses per spec file (relative to `outDir`), one Playwright spec entry
 * per run, plus the control spec's statuses. Every run carries a long, colored error message.
 */
const fakeRunner =
  (statuses: Record<string, string[]>, calls: string[][], control = ['passed', 'passed', 'passed']): RunReplay =>
  async (specs) => {
    calls.push(specs)
    const entries: [string, string[]][] = [...Object.entries(statuses), [relative(outDir, controlSpec()), control]]
    const report: ReplayReport = {
      config: { rootDir: outDir },
      errors: [],
      suites: entries.map(([file, runs]) => ({
        specs: runs.map((status, run) => ({
          file,
          tests: [
            {
              results: [
                {
                  status,
                  errors: [
                    { message: 'Test timeout of 60000ms exceeded.' },
                    { message: `\u001b[31mError: run ${run} of ${file}\u001b[39m\n${'call log\n'.repeat(300)}` },
                  ],
                  attachments: [
                    { name: 'video', path: join(process.cwd(), `qa-out/replay/${file}-${run}/video.webm`) },
                    { name: 'trace', path: join(process.cwd(), `qa-out/replay/${file}-${run}/trace.zip`) },
                  ],
                },
              ],
            },
          ],
        })),
      })),
    }
    return report
  }

const titles = (files: { finding: RawFinding }[]) => files.map((file) => file.finding.title)
const droppedAt = (result: Verified, gate: Verified['dropped'][number]['gate']) =>
  result.dropped.filter((entry) => entry.gate === gate)

describe('replay', () => {
  test('a probe line filed as a console error is an observation, as a layout finding it replays', async () => {
    await Bun.write(join(qaDir, 'noise.txt'), await Bun.file(join(import.meta.dir, '../noise.txt')).text())
    const evidence = '[ERROR] [qa-layout] covered button "Continue" @ http://localhost:1424/layout-probe.js:209'
    await writeFinding(makeFinding('mislabeled', { type: 'console-error', evidence }))
    await writeFinding(makeFinding('layout', { type: 'layout', evidence }))
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(titles(result.observations)).toEqual(['mislabeled'])
    expect(calls[0]).toEqual([controlSpec(), join(outDir, 'c2-chat/repro/layout.spec.ts')])
  })

  test('only findings with an oracle, outside the noise list and with a clean spec reach Playwright', async () => {
    await Bun.write(join(outDir, 'c2-chat/findings/broken.json'), '{ not json')
    await writeFinding(makeFinding('no-oracle', { type: 'looks-off', evidence: 'the button seems odd' }))
    await writeFinding(makeFinding('blank-evidence', { type: 'page-error', evidence: '  ' }))
    await writeFinding(makeFinding('noise', { type: 'console-error', evidence: 'Error: ResizeObserver loop limit' }))
    await writeFinding(makeFinding('console', { type: 'console-error', evidence: 'Failed to load chat list' }))
    // The noise list only applies to console errors.
    await writeFinding(makeFinding('page-noise', { type: 'page-error', evidence: 'ResizeObserver loop crashed' }))
    await writeFinding(makeFinding('unsafe', pageError), 'const key = process.env.ANTHROPIC_API_KEY\n')
    await writeFinding(makeFinding('missing-spec', pageError), null)
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls).toEqual([
      [controlSpec(), join(outDir, 'c2-chat/repro/console.spec.ts'), join(outDir, 'c2-chat/repro/page-noise.spec.ts')],
    ])
    expect(titles(result.observations)).toEqual(['blank-evidence', 'no-oracle', 'noise'])
    expect(droppedAt(result, 'schema')).toEqual([
      {
        file: expect.objectContaining({ charterDir: 'c2-chat', id: 'broken' }),
        gate: 'schema',
        reason: expect.any(String),
      },
    ])
    const lint = droppedAt(result, 'lint')
    expect(lint.map((entry) => entry.file.id)).toEqual(['missing-spec', 'unsafe'])
    expect(lint[0].reason).toBe('repro spec not found')
    expect(lint[1].reason).toContain('"process" is not allowed')
  })

  test('failed 3/3 is confirmed, 1–2/3 flaky and 0/3 dropped, keeping the first failed run details', async () => {
    for (const title of ['always', 'twice', 'once', 'never']) await writeFinding(makeFinding(title, pageError))
    // Two findings with one spec share its replay.
    await writeFinding({ ...makeFinding('always-again', pageError), repro_spec: 'repro/always.spec.ts' }, null)
    const calls: string[][] = []
    const runner = fakeRunner(
      {
        'c2-chat/repro/always.spec.ts': ['failed', 'timedOut', 'failed'],
        'c2-chat/repro/twice.spec.ts': ['passed', 'failed', 'failed', 'skipped'],
        'c2-chat/repro/once.spec.ts': ['failed', 'interrupted', 'passed'],
        'c2-chat/repro/never.spec.ts': ['passed', 'passed', 'passed'],
      },
      calls,
    )

    const result = await replay(outDir, runner, qaDir)

    expect(calls[0]).toHaveLength(5)
    expect(titles(result.confirmed)).toEqual(['always-again', 'always'])
    expect(result.confirmed[0].replay).toEqual(result.confirmed[1].replay)
    expect(result.confirmed[1]).toMatchObject({
      replay: { failed: 3, runs: 3 },
      artifacts: {
        video: 'qa-out/replay/c2-chat/repro/always.spec.ts-0/video.webm',
        trace: 'qa-out/replay/c2-chat/repro/always.spec.ts-0/trace.zip',
      },
    })
    expect(titles(result.flaky)).toEqual(['once', 'twice'])
    // The first failed run's error, without ANSI colors and capped.
    expect(result.confirmed[1].replay.error).toStartWith(
      'Test timeout of 60000ms exceeded.\nError: run 0 of c2-chat/repro/always.spec.ts\ncall log\n',
    )
    expect(result.confirmed[1].replay.error).toHaveLength(1_500)
    expect(result.flaky.map(({ replay: { failed, runs } }) => [failed, runs])).toEqual([
      [1, 3],
      [2, 3],
    ])
    expect(result.flaky[1].artifacts.video).toBe('qa-out/replay/c2-chat/repro/twice.spec.ts-1/video.webm')
    expect(droppedAt(result, 'replay')).toEqual([
      {
        file: expect.objectContaining({ id: 'never', replay: { failed: 0, runs: 3 }, artifacts: {} }),
        gate: 'replay',
        reason: 'failed 0/3 replays',
      },
    ])
  })

  test('a real-AI charter confirms at 2/3 failures and is flaky at 1/3, while other charters still need 3/3', async () => {
    const real = 'c5-widgets-connections-desktop'
    for (const title of ['twice', 'once', 'never', 'always']) {
      const finding = { ...makeFinding(title, pageError), charter: real }
      await Bun.write(join(outDir, real, 'findings', `${title}.json`), JSON.stringify(finding))
      await Bun.write(join(outDir, real, finding.repro_spec), validSpec(title))
    }
    await writeFinding(makeFinding('fake-twice', pageError))
    const runner = fakeRunner(
      {
        [`${real}/repro/twice.spec.ts`]: ['failed', 'passed', 'timedOut'],
        [`${real}/repro/once.spec.ts`]: ['passed', 'failed', 'passed'],
        [`${real}/repro/never.spec.ts`]: ['passed', 'passed', 'passed'],
        [`${real}/repro/always.spec.ts`]: ['failed', 'failed', 'failed'],
        'c2-chat/repro/fake-twice.spec.ts': ['failed', 'passed', 'failed'],
      },
      [],
    )

    const result = await replay(outDir, runner, qaDir)

    expect(titles(result.confirmed)).toEqual(['always', 'twice'])
    expect(titles(result.flaky)).toEqual(['fake-twice', 'once'])
    expect(droppedAt(result, 'replay').map((entry) => entry.file.id)).toEqual(['never'])
  })

  test('replays at most 20 findings and defers the rest, in path order', async () => {
    const ids = Array.from({ length: 21 }, (_, n) => `f${String(n).padStart(2, '0')}`)
    for (const id of ids) await writeFinding(makeFinding(id, pageError))
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls[0]).toHaveLength(21) // the control spec and 20 findings
    expect(calls[0]).not.toContain(join(outDir, 'c2-chat/repro/f20.spec.ts'))
    expect(result.deferred).toEqual([
      { file: expect.objectContaining({ id: 'f20' }), step: 'replay', reason: 'over the cap of 20 replayed findings' },
    ])
    expect(result.dropped.map((entry) => entry.file.id)).not.toContain('f20')
  })

  test('a spec missing from the report is dropped, and nothing replayable means no Playwright run', async () => {
    await writeFinding(makeFinding('lost', pageError))
    const calls: string[][] = []
    const result = await replay(outDir, fakeRunner({}, calls), qaDir)
    expect(droppedAt(result, 'replay')[0].reason).toBe('failed 0/0 replays')

    await rm(join(outDir, 'c2-chat'), { recursive: true })
    await writeFinding(makeFinding('no-oracle', { type: 'looks-off', evidence: 'odd' }))
    await replay(outDir, fakeRunner({}, calls), qaDir)
    expect(calls).toHaveLength(1)
  })

  test('a failed control run aborts the replay: nothing is confirmed and the output says why', async () => {
    for (const title of ['always', 'twice']) await writeFinding(makeFinding(title, pageError))
    const runner = fakeRunner(
      { 'c2-chat/repro/always.spec.ts': ['failed', 'failed', 'failed'], 'c2-chat/repro/twice.spec.ts': ['failed'] },
      [],
      ['passed', 'timedOut', 'passed'],
    )

    const result = await replay(outDir, runner, qaDir)

    expect(result.stack_unhealthy).toStartWith(
      'control spec failed 1/3 runs: Test timeout of 60000ms exceeded.\nError: run 1 of ',
    )
    expect(result.confirmed).toEqual([])
    expect(result.flaky).toEqual([])
    expect(result.dropped.map((entry) => [entry.file.id, entry.gate, entry.reason])).toEqual([
      ['always', 'replay', 'stack unhealthy'],
      ['twice', 'replay', 'stack unhealthy'],
    ])
    const written: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
    expect(written.stack_unhealthy).toBe(result.stack_unhealthy)
  })

  test('a control spec missing from the report counts as an unhealthy stack', async () => {
    await writeFinding(makeFinding('always', pageError))
    const result = await replay(outDir, fakeRunner({ 'c2-chat/repro/always.spec.ts': ['failed'] }, [], []), qaDir)
    expect(result.stack_unhealthy).toBe('control spec failed 0/0 runs: it did not run')
    expect(result.confirmed).toEqual([])
  })

  test('a spec that fails to load is dropped at lint, and the rest replay again with the control', async () => {
    for (const title of ['good', 'broken']) await writeFinding(makeFinding(title, pageError))
    const good = join(outDir, 'c2-chat/repro/good.spec.ts')
    const broken = join(outDir, 'c2-chat/repro/broken.spec.ts')
    const linkError = {
      message:
        "SyntaxError: The requested module '../../../e2e/helpers' does not provide an export named 'loginX'\n  at x",
    }
    const calls: string[][] = []
    const listed: string[][] = []
    const replays = fakeRunner({ 'c2-chat/repro/good.spec.ts': ['failed', 'failed', 'failed'] }, calls)
    // Like Playwright: one file that fails to load stops the whole run, and the error names no file.
    const runner: RunReplay = async (specs, dir, opts) => {
      if (opts?.list) listed.push(specs)
      if (specs.includes(broken)) return { config: { rootDir: outDir }, suites: [], errors: [linkError] }
      if (opts?.list) return { config: { rootDir: outDir }, suites: [], errors: [] }
      return replays(specs, dir)
    }

    const result = await replay(outDir, runner, qaDir)

    expect(listed).toEqual([[broken], [good]])
    expect(calls).toEqual([[controlSpec(), good]])
    expect(result.stack_unhealthy).toBeUndefined()
    expect(titles(result.confirmed)).toEqual(['good'])
    expect(droppedAt(result, 'lint')).toEqual([
      {
        file: expect.objectContaining({ id: 'broken' }),
        gate: 'lint',
        reason: `failed to load: ${linkError.message.split('\n')[0]}`,
      },
    ])
  })

  test('a load error that no repro spec explains marks the stack unhealthy with that error', async () => {
    await writeFinding(makeFinding('always', pageError))
    const listed: string[][] = []
    const runner: RunReplay = async (specs, _dir, opts) => {
      if (opts?.list) listed.push(specs)
      return {
        config: { rootDir: outDir },
        suites: [],
        errors: opts?.list ? [] : [{ message: 'Error: helpers broke' }],
      }
    }
    const result = await replay(outDir, runner, qaDir)
    expect(listed).toHaveLength(1)
    expect(result.stack_unhealthy).toBe('control spec failed 0/0 runs: Error: helpers broke')
    expect(droppedAt(result, 'replay').map((entry) => entry.reason)).toEqual(['stack unhealthy'])
  })

  test('replay confirms a visual finding whose screenshot the browser tool took, without Playwright', async () => {
    await writeFinding(makeVisual('shot'), null)
    await writeSession([['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`)]])
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls).toEqual([])
    expect(result.confirmed).toEqual([
      {
        charterDir: 'c2-chat',
        id: 'shot',
        finding: makeVisual('shot'),
        replay: { failed: 0, runs: 0 },
        artifacts: { screenshot: relative(process.cwd(), join(outDir, 'c2-chat/mcp', shotFile)) },
      },
    ])
  })

  test('a visual finding does not take a place under the replay cap', async () => {
    for (let n = 0; n < 20; n++) await writeFinding(makeFinding(`f${String(n).padStart(2, '0')}`, pageError))
    await writeFinding(makeVisual('shot'), null)
    await writeSession([['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`)]])

    const result = await replay(outDir, fakeRunner({}, []), qaDir)

    expect(result.deferred).toEqual([])
    expect(titles(result.confirmed)).toEqual(['shot'])
  })

  test('replay drops a visual finding whose screenshot the session never took, or that is missing', async () => {
    await writeFinding(makeVisual('untaken'), null)
    await writeFinding(makeVisual('lost', 'mcp/page-lost.png'), null)
    await writeSession([
      // The explorer typed the file name into the page and read it back: not a screenshot.
      ['mcp__playwright__browser_evaluate', `### Result\n"${sessionDir}/mcp/${shotFile}"`],
      ['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`, 'page-lost.png')],
    ])

    const result = await replay(outDir, fakeRunner({}, []), qaDir)

    expect(result.confirmed).toEqual([])
    expect(droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['lost', 'screenshot not found'],
      ['untaken', 'screenshot not taken by the browser tool in this session'],
    ])
  })

  /** A Write or Edit call on `file_path`, as transcript.jq keeps it, and its result. */
  const fileTool = (name: string, id: string, file_path: string): TranscriptMessage[] => [
    { message: { content: [{ type: 'tool_use', id, name, input: { file_path } }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]

  /** Writes each screenshot under c2-chat/mcp/, a visual finding named after it, and a transcript taking them all. */
  const writeShots = async (shots: Record<string, Buffer>, extra: TranscriptMessage[] = []) => {
    const steps = Object.keys(shots).map(
      (name) => ['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`, name)] as const,
    )
    await Bun.write(join(outDir, 'c2-chat/transcript.json'), JSON.stringify([...callsOf(steps), ...extra]))
    for (const [name, bytes] of Object.entries(shots)) {
      await Bun.write(join(outDir, 'c2-chat/mcp', name), bytes)
      await writeFinding(makeVisual(name.replace(/\.\w+$/, ''), `mcp/${name}`), null)
    }
  }

  const replayDrops = async () => {
    const result = await replay(outDir, fakeRunner({}, []), qaDir)
    return {
      confirmed: titles(result.confirmed),
      dropped: droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason]),
    }
  }

  test('replay drops a visual finding whose screenshot a file tool wrote after the browser', async () => {
    await writeShots({ 'written.png': pngBytes, 'edited.png': pngBytes, 'kept.png': pngBytes }, [
      ...fileTool('Write', 'w0', `${sessionDir}/mcp/written.png`),
      ...fileTool('Edit', 'w1', `${sessionDir}/mcp/edited.png`),
      ...fileTool('Write', 'w2', `${sessionDir}/findings/kept.json`),
    ])

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [
        ['edited', 'screenshot written by a file tool, not the browser'],
        ['written', 'screenshot written by a file tool, not the browser'],
      ],
    })
  })

  test('replay drops a visual finding whose screenshot is not a PNG or a JPEG', async () => {
    await writeShots({ 'text.png': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'kept.png': pngBytes })

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [['text', 'screenshot is not a PNG or JPEG image']],
    })
  })

  test("replay drops a visual finding whose screenshot is over the API's 10 MB image limit", async () => {
    // 7.5 MB of bytes is 10 MB once base64-encoded, which is how the API measures it.
    await writeShots({ 'huge.png': Buffer.concat([pngBytes, Buffer.alloc(7_500_000)]), 'kept.png': pngBytes })

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [['huge', "screenshot over the API's 10 MB image limit"]],
    })
  })

  test("replay drops a visual finding whose screenshot is over the API's 8000 px image limit", async () => {
    await writeShots({ 'tall.png': pngOf(1280, 8001), 'wide.jpeg': jpegOf(8001, 600), 'kept.jpeg': jpegOf(1280, 8000) })

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [
        ['tall', "screenshot over the API's 8000 px image limit"],
        ['wide', "screenshot over the API's 8000 px image limit"],
      ],
    })
  })

  test('a screenshot counts only when a browser screenshot result of the same device names it', () => {
    const transcript = callsOf([
      ['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`, 'page-a.png')],
      ['mcp__playwright_b__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp-b`, 'page-b.png')],
      ['mcp__playwright__browser_evaluate', `${sessionDir}/mcp/page-c.png`],
    ])
    expect(screenshotTaken(transcript, 'mcp/page-a.png')).toBe(true)
    expect(screenshotTaken(transcript, 'mcp-b/page-b.png')).toBe(true)
    expect(screenshotTaken(transcript, 'mcp/page-b.png')).toBe(false)
    expect(screenshotTaken(transcript, 'mcp/page-c.png')).toBe(false)
  })

  test('Playwright gets only the allowlisted variables, never the caller environment', () => {
    expect(Object.keys(replayEnv('qa-out')).sort()).toEqual([
      'CI',
      'HOME',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_NO_COPY_PROMPT',
      'QA_OUT',
    ])
  })

  test('the control spec passes the repro spec lint', async () => {
    const source = await Bun.file(join(import.meta.dir, '../control/stack.spec.ts')).text()
    expect(lintReproSpec(source)).toEqual([])
  })

  test('writes candidates.json with the verified.json shape', async () => {
    await writeFinding(makeFinding('always', pageError))
    const result = await replay(outDir, fakeRunner({ 'c2-chat/repro/always.spec.ts': ['failed'] }, []), qaDir)
    const written: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
    expect(written).toEqual(result)
    expect(Object.keys(written).sort()).toEqual(['confirmed', 'deferred', 'dropped', 'flaky', 'observations'])
    expect(Object.keys(written.confirmed[0]).sort()).toEqual(['artifacts', 'charterDir', 'finding', 'id', 'replay'])
  })
})

describe('judge', () => {
  const candidate = (title: string) => ({
    charterDir: 'c2-chat',
    id: title,
    finding: makeFinding(title, pageError),
    replay: { failed: 3, runs: 3, error: `Error: expect(locator).toBeVisible() failed for ${title}` },
    artifacts: { video: `qa-out/replay/${title}/video.webm` },
  })

  /** Answers each call with the reply keyed by the finding title found in its prompt. */
  const fakeCreate =
    (replies: Record<string, string>, calls: Anthropic.MessageCreateParamsNonStreaming[]): CreateMessage =>
    async (params) => {
      calls.push(params)
      const prompt = String(params.messages[0].content)
      const reply = Object.entries(replies).find(([title]) => prompt.includes(`"title": "${title}"`))?.[1] ?? ''
      return {
        content: [{ type: 'text', text: reply, citations: null }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 250 },
      }
    }

  const writeCandidates = async (candidates: Verified) => {
    await Bun.write(join(outDir, 'candidates.json'), JSON.stringify(candidates))
    for (const file of [...candidates.confirmed, ...candidates.flaky]) {
      const { repro_spec, screenshot, title } = file.finding
      if (repro_spec) await Bun.write(join(outDir, file.charterDir, repro_spec), validSpec(title))
      if (screenshot) await Bun.write(join(outDir, file.charterDir, screenshot), pngBytes)
    }
  }

  const visualCandidate = (finding: RawFinding) => ({
    charterDir: 'c2-chat',
    id: finding.title,
    finding,
    replay: { failed: 0, runs: 0 },
    artifacts: { screenshot: `qa-out/c2-chat/${finding.screenshot}` },
  })

  const recordingCreate =
    (calls: Anthropic.MessageCreateParamsNonStreaming[]): CreateMessage =>
    async (params) => {
      calls.push(params)
      return {
        content: [{ type: 'text', text: '{"keep":true,"reason":"The button is hidden."}', citations: null }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2000, output_tokens: 100 },
      }
    }

  test('the judge sees a visual finding without a spec, and its screenshot typed by its bytes', async () => {
    const png = makeVisual('png')
    // A JPEG saved under a .png name: the bytes decide the media type, not the extension.
    const jpeg = makeVisual('jpeg', 'mcp-b/page-1.png')
    await writeCandidates({ confirmed: [png, jpeg].map(visualCandidate), flaky: [], observations: [], dropped: [] })
    const jpegBytes = jpegOf(390, 844)
    await Bun.write(join(outDir, 'c2-chat/mcp-b/page-1.png'), jpegBytes)
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, recordingCreate(calls), qaDir)

    expect(titles(result.confirmed)).toEqual(['png', 'jpeg'])
    const image = (mediaType: 'image/png' | 'image/jpeg', bytes: Buffer): Anthropic.ImageBlockParam => ({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
    })
    expect(calls.map((call) => call.messages[0].content)).toEqual([
      [image('image/png', pngBytes), { type: 'text', text: `<finding>\n${JSON.stringify(png, null, 2)}\n</finding>` }],
      [
        image('image/jpeg', jpegBytes),
        { type: 'text', text: `<finding>\n${JSON.stringify(jpeg, null, 2)}\n</finding>` },
      ],
    ])
  })

  test('the judge never reads a screenshot path that leaves the session dir', async () => {
    // A candidates.json written by anything but replay. Both files exist, one level above the session dir.
    await Bun.write(join(outDir, 'secret.png'), pngBytes)
    await Bun.write(join(outDir, 'mcp/page-1.png'), pngBytes)
    const outside = [
      { ...visualCandidate(makeVisual('escape')), finding: makeVisual('escape', '../secret.png') },
      { ...visualCandidate(makeVisual('root')), charterDir: '.', finding: makeVisual('root', 'mcp/page-1.png') },
    ]
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    for (const candidate of outside) {
      await Bun.write(
        join(outDir, 'candidates.json'),
        JSON.stringify({ confirmed: [candidate], flaky: [], observations: [], dropped: [] }),
      )
      await expect(judge(outDir, recordingCreate(calls), qaDir)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  test('an image counts toward the judge spend ceiling', async () => {
    expect(worstJudgeCost('s', 'u', 1) - worstJudgeCost('s', 'u', 0)).toBeCloseTo((1_600 * 4) / 1_000_000)
    // Text that fits under the $2 ceiling with 800 input tokens to spare, so only the image's 1,600 push it over.
    const base = makeVisual('tight')
    const room = (2 - (4096 * 20) / 1_000_000) / (4 / 1_000_000) - 1_000 - 26 - 800
    const pad = room - JSON.stringify(base, null, 2).length - '<finding>\n\n</finding>'.length
    const tight = { ...base, actual: 'x'.repeat(Math.floor(pad)) }
    await writeCandidates({ confirmed: [visualCandidate(tight)], flaky: [], observations: [], dropped: [] })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, recordingCreate(calls), qaDir)

    expect(calls).toEqual([])
    expect(result.deferred).toEqual([
      { file: visualCandidate(tight), step: 'judge', reason: "over the judge's spend ceiling of $2" },
    ])
  })

  test('keeps what the judge keeps and drops the rest, defaulting to drop on a malformed reply', async () => {
    const observation = { charterDir: 'c2-chat', id: 'obs', finding: makeFinding('obs', pageError) }
    const earlierDrop = { file: observation, gate: 'lint' as const, reason: 'bad spec' }
    await writeCandidates({
      confirmed: [candidate('real'), candidate('intended'), candidate('garbled'), candidate('wrong-shape')],
      flaky: [candidate('flaky')],
      observations: [observation],
      dropped: [earlierDrop],
    })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
    const create = fakeCreate(
      {
        real: '{"keep":true,"reason":"The send button throws on every click."}',
        intended: '{"keep":false,"reason":"Documented behaviour."}',
        garbled: 'Sure! {"keep": true',
        'wrong-shape': '{"keep":"yes","reason":"looks real"}',
      },
      calls,
    )

    const result = await judge(outDir, create, qaDir)

    expect(calls).toHaveLength(4)
    expect(result.confirmed).toEqual([
      { ...candidate('real'), judge: { keep: true, reason: 'The send button throws on every click.' } },
    ])
    expect(result.flaky).toEqual([candidate('flaky')])
    expect(result.observations).toEqual([observation])
    expect(result.dropped.map((entry) => [entry.file.id, entry.gate, entry.reason])).toEqual([
      ['obs', 'lint', 'bad spec'],
      ['intended', 'judge', 'Documented behaviour.'],
      ['garbled', 'judge', 'malformed judge reply (stop_reason: end_turn)'],
      ['wrong-shape', 'judge', 'malformed judge reply (stop_reason: end_turn)'],
    ])
    expect(result.judge_usage).toEqual({ input_tokens: 4000, output_tokens: 1000, cost_usd: 0.036 })
    expect(await Bun.file(join(outDir, 'verified.json')).json()).toEqual(result)
  })

  test('sends one bounded, structured call per candidate with only the finding, its spec and the known issues', async () => {
    await writeCandidates({ confirmed: [candidate('real')], flaky: [], observations: [], dropped: [] })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    await judge(outDir, fakeCreate({ real: '{"keep":true,"reason":"ok"}' }, calls), qaDir)

    const [params] = calls
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.max_tokens).toBeLessThanOrEqual(8192)
    expect(params.system).toBe('JUDGE PROMPT\n\nKNOWN ISSUES')
    expect(params.output_config?.format?.type).toBe('json_schema')
    expect(params.output_config?.format?.schema).toMatchObject({ required: ['keep', 'reason'] })
    expect(params.messages).toHaveLength(1)
    const prompt = String(params.messages[0].content)
    expect(prompt).toContain('TypeError: messages is undefined')
    expect(prompt).toContain(validSpec('real'))
    expect(prompt).toContain(
      '<replay_failure>\nError: expect(locator).toBeVisible() failed for real\n</replay_failure>',
    )
    expect(prompt).not.toContain('qa-out/replay')
  })

  test('judges at most 15 candidates and defers the rest, keeping the replay leg deferrals', async () => {
    const ids = Array.from({ length: 16 }, (_, n) => `j${String(n).padStart(2, '0')}`)
    const replayDeferred = { file: candidate('late'), step: 'replay' as const, reason: 'over the cap' }
    await writeCandidates({
      confirmed: ids.map(candidate),
      flaky: [],
      observations: [],
      dropped: [],
      deferred: [replayDeferred],
    })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, fakeCreate({}, calls), qaDir)

    expect(calls).toHaveLength(15)
    expect(result.deferred).toEqual([
      replayDeferred,
      { file: candidate('j15'), step: 'judge', reason: 'over the cap of 15 judged findings' },
    ])
    expect(result.dropped.map((entry) => entry.file.id)).not.toContain('j15')
  })

  test('defers a candidate whose worst-case cost would pass the spend ceiling, and judges the next one', async () => {
    await writeCandidates({
      confirmed: [candidate('huge'), candidate('small')],
      flaky: [],
      observations: [],
      dropped: [],
    })
    // 600,000 bytes may be up to 600,000 input tokens: $2.40 at $4 per million, over the $2 ceiling.
    await Bun.write(join(outDir, 'c2-chat/repro/huge.spec.ts'), 'x'.repeat(600_000))
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, fakeCreate({ small: '{"keep":true,"reason":"ok"}' }, calls), qaDir)

    expect(calls).toHaveLength(1)
    expect(result.confirmed.map((file) => file.id)).toEqual(['small'])
    expect(result.deferred).toEqual([
      { file: candidate('huge'), step: 'judge', reason: "over the judge's spend ceiling of $2" },
    ])
  })

  test('a refusal or a truncated reply is dropped, and no candidates means no calls', async () => {
    await writeCandidates({ confirmed: [candidate('refused')], flaky: [], observations: [], dropped: [] })
    const refuse: CreateMessage = async () => ({
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const result = await judge(outDir, refuse, qaDir)
    expect(result.dropped[0].reason).toBe('malformed judge reply (stop_reason: refusal)')

    await writeCandidates({ confirmed: [], flaky: [], observations: [], dropped: [] })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
    const empty = await judge(outDir, fakeCreate({}, calls), qaDir)
    expect(calls).toHaveLength(0)
    expect(empty.judge_usage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 })
  })
})
