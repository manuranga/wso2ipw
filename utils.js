// WSO2 Integrator automation helpers — load into daemon ctx at session start:
// const code = fs.readFileSync('utils.js','utf8'); await fetch(`http://127.0.0.1:${PORT}`, {method:'POST', body: code})
// or: curl -s --max-time 10 -X POST http://127.0.0.1:$PORT --data-binary @utils.js

// Find the WSO2 webview outer frame (index.html), then return its content child (fake.html).
// Matches extensionId=wso2.* first; falls back to any vscode-webview with a child frame
// for versions/states where the extensionId param disappears after navigation.
findGuestOuter = () => {
  const frames = window.frames()
  return frames.find(f => { try { return /extensionId=wso2\./.test(f.url()) } catch { return false } })
      ?? frames.find(f => { try { return f.url().includes('vscode-webview://') && f.childFrames().length > 0 } catch { return false } })
}

refreshGuest = () => {
  const outer = findGuestOuter()
  guestFrame = outer ? (outer.childFrames()[0] ?? outer) : null
  return guestFrame
}

waitForGuest = async (timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const outer = findGuestOuter()
    if (outer) {
      const inner = outer.childFrames()[0] ?? outer
      try { await inner.evaluate(() => document.readyState); guestFrame = inner; return inner } catch {}
    }
    await window.waitForTimeout(200)
  }
  throw new Error("guest frame not ready (timeout)")
}

guestClick = async (locator) => {
  const box = await locator.evaluate(el => {
    el.scrollIntoView({ block: "nearest" })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  let x = box.x, y = box.y, f = guestFrame
  while (f.parentFrame()) {
    const parent = f.parentFrame(), url = f.url()
    const off = await parent.evaluate(url => {
      for (const fr of document.querySelectorAll("iframe"))
        try {
          if (fr.src === url || fr.contentWindow?.location?.href === url) {
            const r = fr.getBoundingClientRect(); return { x: r.x, y: r.y }
          }
        } catch {}
      const fr = document.querySelector("iframe")
      return fr ? { x: fr.getBoundingClientRect().x, y: fr.getBoundingClientRect().y } : { x: 0, y: 0 }
    }, url)
    x += off.x; y += off.y; f = parent
  }
  await window.mouse.click(x, y)
}

// Fill a vscode-text-field (shadow DOM input) — click to focus then type
guestFill = async (locator, text) => {
  await guestClick(locator)
  await locator.selectText().catch(() => {})
  await window.keyboard.type(text)
}

// Fill a CodeMirror 6 editor
cmFill = async (text) => {
  await guestFrame.evaluate(text => {
    const view = document.querySelector(".cm-content")?.cmView?.view
    if (!view) throw new Error("CM view not found")
    view.focus()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    view.requestMeasure()
  }, text)
}

snapshot = async () => {
  await waitForGuest()
  return await guestFrame.locator("body").ariaSnapshot()
}
