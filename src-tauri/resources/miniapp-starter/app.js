/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { connect } from '/__thunderbolt/sdk.js'

try {
  const thunderbolt = await connect({
    appName: document.title,
    getContext: () => ({ title: document.title, summary: document.body.innerText.slice(0, 500) }),
  })
  // A brand-new app has nothing to show yet, so start with the chat that builds it.
  thunderbolt.openChat()
} catch {
  // Not embedded in Thunderbolt: run standalone.
}
