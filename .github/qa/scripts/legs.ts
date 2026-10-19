#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import platforms from '../platforms.json'
import { parseSession, realAiCharters } from './findings'

/** One explore session of the weekly run, as the workflow's matrix reads it (`charter` is the session id). */
export type Leg = {
  charter: string
  dist: string
  out: string
  artifact: string
  mcp: string
  viewport: string
  onboarding: boolean
  real: boolean
  postgres: boolean
}

/** One replay or judge job of the weekly run. */
export type VerifyLeg = {
  name: string
  out: string
  artifact: string
  dist: string
  onboarding: boolean
  postgres: boolean
  real?: boolean
}

const baseLeg = {
  dist: 'qa-dist',
  out: 'qa-out',
  artifact: 'qa-explore',
  onboarding: false,
  real: false,
  postgres: false,
}

/** The charters that run on every platform. The free session of the week is added by `planLegs`. */
const charters: (Partial<Leg> & { charter: string })[] = [
  { charter: 'c1-first-run', onboarding: true },
  { charter: 'c2-chat-power-user' },
  { charter: 'c3-models-providers' },
  { charter: 'c4-skills-projects' },
  { charter: 'c5-widgets-connections' },
  { charter: 'c6-settings-data' },
  { charter: 'c7-two-devices', postgres: true, artifact: 'qa-sync' },
]

/**
 * Whether a dispatch's `only` list picks this session. A session id picks one session, a charter id picks it on every
 * platform, `free` picks the free sessions, and an empty list picks everything. The canary filter in `report.ts`
 * shares this rule.
 */
export const selects = (only: string[], session: string) =>
  only.length === 0 ||
  only.includes(session) ||
  only.includes(parseSession(session).charter) ||
  (session.startsWith('free-') && only.includes('free'))

/** Every session of the week on every platform, then one extra leg per canary on the canary build. */
const allLegs = (journey: string, canaries: { charter: string }[]): Leg[] => {
  const sessions = [...charters, { charter: `free-${journey}` }].flatMap((c) =>
    platforms.map((platform): Leg => {
      const session = `${c.charter}-${platform.id}`
      // c7's second browser is added to whichever platform's config the session would use.
      const mcp = c.charter === 'c7-two-devices' ? `${platform.mcp} .github/qa/mcp-two-devices.json` : platform.mcp
      const leg = { ...baseLeg, ...c, charter: session, mcp, viewport: platform.viewport }
      return realAiCharters.has(session) ? { ...leg, real: true, artifact: 'qa-real' } : leg
    }),
  )
  const canaryLegs = canaries.flatMap((canary) =>
    sessions
      .filter((leg) => leg.charter === canary.charter)
      .map((leg) => ({ ...leg, dist: 'qa-dist-canary', out: 'qa-out-canary', artifact: 'qa-canary' })),
  )
  return [...sessions, ...canaryLegs]
}

/** The replay legs for the selected explore legs: one per kind of stack they explored, plus the canary pair. */
const verifyLegs = (legs: Leg[]): VerifyLeg[] => {
  const has = (artifact: string) => legs.some((leg) => leg.artifact === artifact)
  const weekly: VerifyLeg = {
    name: 'weekly',
    out: 'qa-out',
    artifact: 'qa-explore',
    dist: 'qa-dist',
    onboarding: legs.some((leg) => leg.onboarding),
    postgres: false,
  }
  const sync: VerifyLeg = { ...weekly, name: 'sync', artifact: 'qa-sync', onboarding: false, postgres: true }
  const real: VerifyLeg = { ...weekly, name: 'real', artifact: 'qa-real', onboarding: false, real: true }
  // The canary findings replay on the canary build, then on the normal one: a canary counts only when its finding
  // fails on the first and passes on the second. canaries.ts picks charters of one kind of AI.
  const canaryReal = legs.some((leg) => leg.artifact === 'qa-canary' && leg.real)
  const canary = [
    { name: 'canary', out: 'qa-out-canary', dist: 'qa-dist-canary' },
    { name: 'canary-baseline', out: 'qa-out-canary-baseline', dist: 'qa-dist' },
  ].map((leg): VerifyLeg => ({ ...leg, artifact: 'qa-canary', onboarding: false, postgres: false, real: canaryReal }))
  return [
    weekly,
    ...(has('qa-sync') ? [sync] : []),
    ...(has('qa-real') ? [real] : []),
    ...(has('qa-canary') ? canary : []),
  ]
}

/**
 * The weekly run's plan: the legs to explore (`only` narrows them, see `selects`), the replay legs and the judge
 * legs. Throws on an id in `only` that names no session, charter or `free`.
 */
export const planLegs = (input: { only: string[]; journey: string; canaries: { charter: string }[] }) => {
  const all = allLegs(input.journey, input.canaries)
  const known = new Set(['free', ...all.flatMap((leg) => [leg.charter, parseSession(leg.charter).charter])])
  const unknown = input.only.filter((id) => !known.has(id))
  if (unknown.length > 0) throw new Error(`Unknown charter ${unknown.join(' ')}`)
  const legs = all.filter((leg) => selects(input.only, leg.charter))
  const verify = verifyLegs(legs)
  return { legs, verify, judge: verify.filter((v) => v.name === 'weekly' || v.name === 'canary') }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { charters: { type: 'string', default: '' }, journey: { type: 'string' }, canaries: { type: 'string' } },
  })
  if (!values.journey || !values.canaries)
    throw new Error('usage: legs.ts --charters "<ids>" --journey <id> --canaries <file>')
  try {
    // Commas and spaces both separate ids.
    const only = values.charters.split(/[ ,]+/).filter(Boolean)
    if (values.charters && only.length === 0) throw new Error(`No charter id in '${values.charters}'`)
    const { legs, verify, judge } = planLegs({
      only,
      journey: values.journey,
      canaries: JSON.parse(await readFile(values.canaries, 'utf8')),
    })
    for (const [name, value] of Object.entries({ legs, verify, judge })) console.log(`${name}=${JSON.stringify(value)}`)
  } catch (error) {
    // A workflow annotation, so the run's summary shows the reason.
    console.log(`::error::${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
