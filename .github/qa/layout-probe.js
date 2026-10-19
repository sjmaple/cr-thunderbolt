/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layout probe. The explore agent's browser runs it in every page (Playwright MCP `--init-script`) and repro
// specs inject it through layout.ts. It logs `[qa-layout] ready` once per page load and each confirmed problem once
// as `[qa-layout] <kind> <role> "<name>"`, all with console.error: the MCP passes on nothing quieter.
;(() => {
  if (window.top !== window || window.__qaLayout) return

  const interactive = 'input, textarea, select, button, a[href], [role=button], [role=link], [contenteditable=true]'
  const implicitRoles = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }
  const debounceMs = 250
  // A problem counts once it has been in every check for this long, so animations and transitions settle first.
  const confirmMs = 500

  const firstSeen = new Map()
  const logged = new Set()
  let confirmed = []
  let timer

  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim()
  const accessibleName = (el) =>
    clean(el.getAttribute('aria-label')) ||
    clean(
      el
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .join(' '),
    ) ||
    clean(el.labels?.[0]?.textContent) ||
    clean(el.textContent) ||
    clean(el.getAttribute('placeholder')) ||
    clean(el.getAttribute('title'))
  const describe = (el) =>
    `${el.getAttribute('role') || implicitRoles[el.tagName] || el.tagName.toLowerCase()} "${accessibleName(el).slice(0, 50)}"`

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  // Behind a modal the background is aria-hidden or inert, or inherits the body's `pointer-events: none`.
  const isCandidate = (el) =>
    isVisible(el) && !el.closest('[aria-hidden=true], [inert]') && getComputedStyle(el).pointerEvents !== 'none'

  // The math of src/hooks/use-keyboard-inset.ts.
  const keyboardOpen = (vv) => innerHeight - vv.height - vv.offsetTop > 100
  // With the keyboard open, behind-keyboard owns the area it hides, so the other checks measure the window.
  const viewArea = (vv) =>
    keyboardOpen(vv)
      ? { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: innerHeight }
      : { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }

  // The ancestors that can clip or scroll el, below <body>. A fixed box ends the list: nothing above it moves it.
  const containersOf = (el) => {
    const chain = []
    for (let node = el; ; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return { chain, fixed: true }
      if (!node.parentElement || node.parentElement === document.body) return { chain, fixed: false }
      chain.push(node.parentElement)
    }
  }

  const room = {
    up: (node) => node.scrollTop > 0,
    down: (node) => node.scrollTop + node.clientHeight < node.scrollHeight - 1,
    left: (node) => node.scrollLeft > 0,
    right: (node) => node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
  }
  const axisOf = { up: 'overflowY', down: 'overflowY', left: 'overflowX', right: 'overflowX' }
  const canScroll = ({ chain, fixed }, direction) => {
    const axis = axisOf[direction]
    const documentScrolls = ![document.documentElement, document.body].some((node) =>
      /hidden|clip/.test(getComputedStyle(node)[axis]),
    )
    return (
      chain.some((node) => /auto|scroll/.test(getComputedStyle(node)[axis]) && room[direction](node)) ||
      (!fixed && documentScrolls && room[direction](document.scrollingElement))
    )
  }

  const clipArea = ({ chain }, area) =>
    chain.reduce((box, node) => {
      const style = getComputedStyle(node)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') return box
      const rect = node.getBoundingClientRect()
      return {
        left: Math.max(box.left, rect.left),
        top: Math.max(box.top, rect.top),
        right: Math.min(box.right, rect.right),
        bottom: Math.min(box.bottom, rect.bottom),
      }
    }, area)

  const isOffscreen = (rect, area, containers) => {
    // Wholly past a side edge is a drawer or carousel slide parked off canvas on purpose.
    if (rect.right <= area.left || rect.left >= area.right) return false
    const directions = [
      rect.top < area.top - 1 && 'up',
      rect.bottom > area.bottom + 1 && 'down',
      rect.left < area.left - 1 && 'left',
      rect.right > area.right + 1 && 'right',
    ].filter(Boolean)
    return directions.some((direction) => !canScroll(containers, direction))
  }

  const isCovered = (el, rect, area, containers) => {
    const x = (rect.left + rect.right) / 2
    const y = (rect.top + rect.bottom) / 2
    const clip = clipArea(containers, area)
    if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return false
    const hit = document.elementFromPoint(x, y)
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false
    // A toast floats in a live region and leaves on its own. An inline alert over a control is still a bug.
    if (hit.closest('[aria-live], [role=status], [role=alert], [role=log]') && containersOf(hit).fixed) return false
    // A sticky header or fixed footer over content the page can still scroll out from under it.
    const hitRect = hit.getBoundingClientRect()
    return !canScroll(containers, hitRect.top + hitRect.height / 2 > innerHeight / 2 ? 'down' : 'up')
  }

  const behindKeyboard = (vv, candidates) => {
    if (!keyboardOpen(vv)) return []
    const line = vv.offsetTop + vv.height
    const focused = document.activeElement
    const topDialog = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')]
      .filter(isVisible)
      .at(-1)
    const scope = topDialog ?? focused?.closest('form')
    const buttons = candidates.filter((el) => scope?.contains(el) && el.matches('button, [role=button]'))
    return [...new Set([focused, ...buttons])].filter(
      (el) =>
        candidates.includes(el) && el.getBoundingClientRect().bottom > line + 1 && !canScroll(containersOf(el), 'down'),
    )
  }

  // The `overflow` check the explore prompt used to run by hand, now at every width.
  const overflows = () => {
    const root = document.documentElement
    const page =
      root.scrollWidth > root.clientWidth
        ? [{ kind: 'overflow-page', target: `document "${document.title.slice(0, 50)}"` }]
        : []
    const texts = [...document.querySelectorAll('body *')]
      .filter((el) => {
        if (el.childElementCount !== 0 || el.clientWidth <= 1 || el.textContent.trim() === '') return false
        if (el.scrollWidth <= el.clientWidth + 1) return false
        const style = getComputedStyle(el)
        return style.textOverflow !== 'ellipsis' && !/auto|scroll/.test(style.overflowX)
      })
      .slice(0, 10)
      .map((el) => ({ kind: 'overflow-text', target: describe(el) }))
    return [...page, ...texts]
  }

  const measure = () => {
    const vv = window.visualViewport
    const area = viewArea(vv)
    const candidates = [...document.querySelectorAll(interactive)].filter(isCandidate)
    const found = candidates.flatMap((el) => {
      const rect = el.getBoundingClientRect()
      const containers = containersOf(el)
      return [
        isOffscreen(rect, area, containers) && { kind: 'offscreen', target: describe(el) },
        isCovered(el, rect, area, containers) && { kind: 'covered', target: describe(el) },
      ].filter(Boolean)
    })
    const keyboard = behindKeyboard(vv, candidates).map((el) => ({ kind: 'behind-keyboard', target: describe(el) }))
    return [...found, ...keyboard, ...overflows()]
  }

  const check = () => {
    const now = performance.now()
    const current = new Map(measure().map((problem) => [`${problem.kind} ${problem.target}`, problem]))
    for (const key of firstSeen.keys()) if (!current.has(key)) firstSeen.delete(key)
    for (const key of current.keys()) if (!firstSeen.has(key)) firstSeen.set(key, now)
    const confirmedKeys = [...current.keys()].filter((key) => now - firstSeen.get(key) >= confirmMs)
    confirmed = confirmedKeys.map((key) => current.get(key))
    for (const key of confirmedKeys.filter((key) => !logged.has(key))) {
      logged.add(key)
      console.error(`[qa-layout] ${key}`)
    }
    if (confirmedKeys.length < current.size) schedule(confirmMs + 10)
  }

  const schedule = (delay) => {
    clearTimeout(timer)
    timer = setTimeout(check, delay)
  }

  const start = () => {
    const onChange = () => schedule(debounceMs)
    new MutationObserver(onChange).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    addEventListener('resize', onChange)
    window.visualViewport.addEventListener('resize', onChange)
    window.visualViewport.addEventListener('scroll', onChange)
    // The page and its lists scrolling change what covers what, and the visual viewport never sees them.
    document.addEventListener('scroll', onChange, { capture: true, passive: true })
    document.addEventListener('focusin', onChange)
    check()
  }

  window.__qaLayout = { problems: () => [...confirmed] }
  console.error('[qa-layout] ready')
  if (document.readyState === 'complete') start()
  else addEventListener('load', start, { once: true })
})()
