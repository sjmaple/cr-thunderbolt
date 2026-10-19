/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { planLegs, selects } from './legs'

const plan = (only: string[] = [], canaries: { charter: string }[] = []) =>
  planLegs({ only, journey: 'trip-planner', canaries })

describe('planLegs', () => {
  it('runs every charter on every platform, plus the free session', () => {
    expect(plan().legs).toHaveLength(7 * 2 + 2)
  })

  it('keeps the onboarding build for the onboarding charter on the phone', () => {
    expect(plan().legs.find((l) => l.charter === 'c1-first-run-phone')).toMatchObject({
      onboarding: true,
      viewport: '390x844',
      mcp: '.github/qa/mcp.json',
    })
  })

  it('gives c7 its second browser on each platform', () => {
    expect(plan().legs.find((l) => l.charter === 'c7-two-devices-phone')).toMatchObject({
      postgres: true,
      artifact: 'qa-sync',
      mcp: '.github/qa/mcp.json .github/qa/mcp-two-devices.json',
    })
  })

  it('replays real-AI charters with the real providers', () => {
    expect(plan().legs.find((l) => l.charter === 'c3-models-providers-desktop')).toMatchObject({
      real: true,
      artifact: 'qa-real',
    })
    expect(plan().legs.find((l) => l.charter === 'c2-chat-power-user-desktop')).toMatchObject({
      real: false,
      artifact: 'qa-explore',
    })
  })

  it('selects every platform of a charter id and one session by its session id', () => {
    expect(plan(['c2-chat-power-user']).legs.map((l) => l.charter)).toEqual([
      'c2-chat-power-user-desktop',
      'c2-chat-power-user-phone',
    ])
    expect(plan(['c2-chat-power-user-phone']).legs).toHaveLength(1)
    expect(plan(['free']).legs.map((l) => l.charter)).toEqual(['free-trip-planner-desktop', 'free-trip-planner-phone'])
  })

  it('rejects an unknown charter, even next to a known one', () => {
    expect(() => plan(['nope'])).toThrow('Unknown charter nope')
    expect(() => plan(['c2-chat-power-user', 'c9-nothing'])).toThrow('Unknown charter c9-nothing')
  })

  it('adds a canary as its session on the canary build, and a charter id selects it too', () => {
    const canaries = [{ charter: 'c4-skills-projects-desktop' }]
    expect(plan([], canaries).legs.at(-1)).toMatchObject({
      charter: 'c4-skills-projects-desktop',
      dist: 'qa-dist-canary',
      out: 'qa-out-canary',
      artifact: 'qa-canary',
    })
    expect(plan(['c4-skills-projects'], canaries).legs.map((l) => l.artifact)).toEqual([
      'qa-real',
      'qa-real',
      'qa-canary',
    ])
    expect(plan(['c6-settings-data'], canaries).legs.some((l) => l.artifact === 'qa-canary')).toBe(false)
  })

  it('keeps a real-AI canary on the real providers', () => {
    expect(plan([], [{ charter: 'c4-skills-projects-desktop' }]).legs.at(-1)).toMatchObject({ real: true })
  })

  it('replays each kind of leg on its own stack', () => {
    expect(plan().verify.map((v) => v.name)).toEqual(['weekly', 'sync', 'real'])
    expect(plan().verify[0]).toMatchObject({ artifact: 'qa-explore', onboarding: true, postgres: false })
    expect(plan().verify[1]).toMatchObject({ artifact: 'qa-sync', postgres: true })
    expect(plan().verify[2]).toMatchObject({ artifact: 'qa-real', real: true })
  })

  it('adds no onboarding, sync or real replay when no leg needs it', () => {
    const { verify } = plan(['c6-settings-data'])
    expect(verify.map((v) => v.name)).toEqual(['weekly'])
    expect(verify[0]?.onboarding).toBe(false)
  })

  it('replays canaries on the canary build, then on the normal one, and judges only weekly and canary', () => {
    const { verify, judge } = plan(['c2-chat-power-user'], [{ charter: 'c2-chat-power-user-phone' }])
    expect(verify.slice(1)).toEqual([
      expect.objectContaining({ name: 'canary', out: 'qa-out-canary', dist: 'qa-dist-canary', real: false }),
      expect.objectContaining({ name: 'canary-baseline', out: 'qa-out-canary-baseline', dist: 'qa-dist', real: false }),
    ])
    expect(judge.map((v) => v.name)).toEqual(['weekly', 'canary'])
  })

  it('replays a real-AI canary on the real providers', () => {
    const { verify } = plan(['c4-skills-projects'], [{ charter: 'c4-skills-projects-desktop' }])
    expect(verify.filter((v) => v.name.startsWith('canary')).map((v) => v.real)).toEqual([true, true])
  })
})

describe('selects', () => {
  it('matches everything when nothing is selected', () => {
    expect(selects([], 'c2-chat-power-user-phone')).toBe(true)
  })

  it('matches by session id, charter id or the free keyword', () => {
    expect(selects(['c2-chat-power-user-phone'], 'c2-chat-power-user-phone')).toBe(true)
    expect(selects(['c2-chat-power-user-phone'], 'c2-chat-power-user-desktop')).toBe(false)
    expect(selects(['c2-chat-power-user'], 'c2-chat-power-user-desktop')).toBe(true)
    expect(selects(['free'], 'free-trip-planner-phone')).toBe(true)
    expect(selects(['free'], 'c2-chat-power-user-phone')).toBe(false)
  })
})
