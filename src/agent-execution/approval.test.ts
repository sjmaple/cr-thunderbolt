/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { tool } from 'ai'
import { z } from 'zod'
import { createToolAuthorizer, isPathInside, withToolApproval } from './approval'

describe('built-in tool approval', () => {
  it('allows audited reads without prompting and asks before writes, shell and unknown tools', async () => {
    const requestPermission = mock(
      async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    )
    const authorize = createToolAuthorizer(
      { location: 'computer', access: 'ask', cwd: '/work' },
      { threadId: 'chat', requestPermission },
    )
    for (const name of ['read', 'search', 'google_get_email', 'skill']) {
      await authorize(name, {}, name)
    }
    expect(requestPermission).not.toHaveBeenCalled()
    for (const name of ['write', 'edit', 'bash', 'mcp_send_message']) {
      await authorize(name, { path: 'a' }, name)
    }
    expect(requestPermission).toHaveBeenCalledTimes(4)
    expect(requestPermission.mock.calls[0][0]).toMatchObject({
      sessionId: 'chat',
      toolCall: { rawInput: { workingDirectory: '/work', location: 'computer' } },
    })
  })

  it('does not execute a denied action in the legacy tool pipeline', async () => {
    const execute = mock(async () => 'changed')
    const authorize = createToolAuthorizer(
      { location: 'sandbox', access: 'ask' },
      {
        threadId: 'chat',
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'deny' } }),
      },
    )
    const gated = withToolApproval({ send: tool({ inputSchema: z.object({}), execute }) }, authorize)
    await expect(gated.send.execute!({}, { toolCallId: 'send-1', messages: [] })).rejects.toThrow('denied')
    expect(execute).not.toHaveBeenCalled()
  })

  it('full access executes without prompting, but still honors cancellation', async () => {
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
    )
    const authorize = createToolAuthorizer(
      { location: 'computer', access: 'full', cwd: '/workspace' },
      { threadId: 'chat', requestPermission },
    )
    await authorize('bash', {}, 'one')
    expect(requestPermission).not.toHaveBeenCalled()
    await expect(authorize('bash', {}, 'two', AbortSignal.abort())).rejects.toThrow()
  })

  it('serializes approval requests and checks for cancellation after approval', async () => {
    const first = Promise.withResolvers<RequestPermissionResponse>()
    const requestPermission = mock(() => first.promise)
    const authorize = createToolAuthorizer(
      { location: 'sandbox', access: 'ask' },
      { threadId: 'chat', requestPermission },
    )
    const controller = new AbortController()
    const a = authorize('write', {}, 'a', controller.signal)
    const b = authorize('edit', {}, 'b', controller.signal)
    const settled = Promise.allSettled([a, b])
    await Promise.resolve()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    controller.abort()
    first.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the approval bridge is absent', async () => {
    const authorize = createToolAuthorizer({ location: 'sandbox', access: 'ask' }, { threadId: 'chat' })
    await expect(authorize('write', {}, 'id')).rejects.toThrow('approval is unavailable')
  })

  it('build mode edits the app folder without asking, but still asks for shell and paths outside it', async () => {
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
    )
    const authorize = createToolAuthorizer(
      { location: 'app', access: 'ask', cwd: '/data/mini-apps/todo', appId: 'todo' },
      { threadId: 'chat', requestPermission },
    )
    await authorize('write', { path: 'index.html' }, 'w1')
    await authorize('edit', { path: '/data/mini-apps/todo/app.js' }, 'e1')
    await authorize('reload_app', {}, 'r1')
    expect(requestPermission).not.toHaveBeenCalled()
    await authorize('write', { path: '../other/index.html' }, 'w2')
    await authorize('write', { path: '/etc/hosts' }, 'w3')
    await authorize('bash', { command: 'ls' }, 'b1')
    expect(requestPermission).toHaveBeenCalledTimes(3)
  })
})

describe('isPathInside', () => {
  it('accepts relative and rooted paths under the folder', () => {
    expect(isPathInside('/apps/todo', 'index.html')).toBe(true)
    expect(isPathInside('/apps/todo', 'css/site.css')).toBe(true)
    expect(isPathInside('/apps/todo/', '/apps/todo/app.js')).toBe(true)
  })

  it('refuses climbing out, siblings sharing a prefix, and other absolute paths', () => {
    expect(isPathInside('/apps/todo', '../x')).toBe(false)
    expect(isPathInside('/apps/todo', 'a/../../x')).toBe(false)
    expect(isPathInside('/apps/todo', '/apps/todo-evil/x')).toBe(false)
    expect(isPathInside('/apps/todo', '/etc/hosts')).toBe(false)
  })
})
