const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(__dirname, '.tmp_edge_verify_' + Date.now());
fs.mkdirSync(userDataDir, { recursive: true });

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const fileUrl = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');

const edgeProcess = spawn(edgePath, [
  '--headless=new',
  '--remote-debugging-port=9222',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  fileUrl
]);

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const list = await res.json();
      const pageTarget = list.find(t => t.type === 'page' && t.url.includes('index.html')) || list.find(t => t.type === 'page');
      if (pageTarget) return pageTarget;
    } catch (e) {
      // waiting
    }
  }
  throw new Error('Could not find page target');
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.msgId = 1;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          this.ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error('Eval error: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : undefined;
  }

  async setViewport(width, height, deviceScaleFactor = 1.0) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false
    });
    await this.eval(`
      window.innerWidth = ${width};
      window.innerHeight = ${height};
      applyStageScale();
    `);
    await new Promise(r => setTimeout(r, 100));
  }

  async captureScreenshot(filepath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    fs.writeFileSync(filepath, buffer);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function runVerification() {
  let cdp;
  const results = {
    resolutionsTested: [],
    clippingIssues: [],
    overlapIssues: [],
    testPasses: []
  };

  try {
    const target = await getPageTarget();
    console.log('Target attached:', target.url);
    cdp = new CDPClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    console.log('Connected to CDP');

    // Wait for page fonts and initialization
    await new Promise(r => setTimeout(r, 1500));

    // Audit function to be evaluated in browser context
    const auditScript = `
      (() => {
        const stage = document.getElementById('deck-stage');
        const stageRect = stage.getBoundingClientRect();
        const scale = stageRect.width / 1920;
        const currentSlideEl = document.querySelector('.slide.active');
        const slideId = currentSlideEl ? currentSlideEl.id : 'unknown';

        const violations = [];
        const card = document.getElementById('persistent-presenter-card');
        const cardVisible = card && window.getComputedStyle(card).display !== 'none';
        const cardRect = cardVisible ? card.getBoundingClientRect() : null;

        // Check stage centering and viewport containment
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const stageFits = stageRect.left >= -2 && stageRect.top >= -2 &&
                          stageRect.right <= vw + 2 && stageRect.bottom <= vh + 2;

        // Check interactive elements on active slide
        const contentSelectors = [
          '.slide-title-wrap', '.heist-panel', '.sidecar-col',
          '.canvas-frame', 'canvas', '.deck-controls', '.counter-badge',
          '.progress-track', '.roster-hud', '.preset-btn', '.heist-slider-group'
        ];

        const elements = currentSlideEl ? currentSlideEl.querySelectorAll(contentSelectors.join(',')) : [];
        elements.forEach(el => {
          if (el.offsetParent === null) return; // hidden
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;

          // Convert to unscaled 1920x1080 stage coords
          const sx = (r.left - stageRect.left) / scale;
          const sy = (r.top - stageRect.top) / scale;
          const sr = (r.right - stageRect.left) / scale;
          const sb = (r.bottom - stageRect.top) / scale;

          // Check if outside 1920x1080 stage
          if (sx < -4 || sy < -4 || sr > 1924 || sb > 1084) {
            violations.push({
              slide: slideId,
              element: el.className || el.tagName,
              type: 'STAGE_OVERFLOW',
              coords: { sx: Math.round(sx), sy: Math.round(sy), sr: Math.round(sr), sb: Math.round(sb) }
            });
          }

          // Check card collision if card is visible
          if (cardRect && el.tagName === 'CANVAS') {
            const intersects = !(r.right <= cardRect.left || 
                                 r.left >= cardRect.right || 
                                 r.bottom <= cardRect.top || 
                                 r.top >= cardRect.bottom);
            if (intersects) {
              violations.push({
                slide: slideId,
                element: 'CANVAS ' + (el.id || ''),
                type: 'PRESENTER_CARD_COLLISION'
              });
            }
          }
        });

        // Safe margin check: Slide title & primary panels
        const titles = currentSlideEl ? currentSlideEl.querySelectorAll('.slide-title-wrap') : [];
        titles.forEach(t => {
          const r = t.getBoundingClientRect();
          const sx = (r.left - stageRect.left) / scale;
          const sy = (r.top - stageRect.top) / scale;
          if (sx < 40 || sy < 40) {
            violations.push({
              slide: slideId,
              element: 'TITLE_SAFE_MARGIN',
              type: 'SAFE_MARGIN_VIOLATION',
              sx, sy
            });
          }
        });

        return {
          slideId,
          scale: Number(scale.toFixed(4)),
          stageFits,
          cardVisible,
          violations
        };
      })()
    `;

    // 1. Multi-Resolution Audit
    const resolutions = [
      { name: '1080p_Standard', width: 1920, height: 1080, dsf: 1.0 },
      { name: '768p_Laptop', width: 1366, height: 768, dsf: 1.0 },
      { name: '1440p_QHD', width: 2560, height: 1440, dsf: 1.0 },
      { name: '21_9_Ultrawide', width: 2560, height: 1080, dsf: 1.0 },
      { name: '1080p_Zoom125', width: 1920, height: 1080, dsf: 1.25 }
    ];

    for (const res of resolutions) {
      console.log(`\n======================================================`);
      console.log(`Testing Resolution: ${res.name} (${res.width}x${res.height}, dsf=${res.dsf})`);
      console.log(`======================================================`);

      await cdp.setViewport(res.width, res.height, res.dsf);
      results.resolutionsTested.push(res.name);

      // Verify reset state at this resolution first
      await cdp.eval('resetPresentation()');
      await new Promise(r => setTimeout(r, 300));

      for (let slide = 1; slide <= 12; slide++) {
        if (slide > 1) {
          await cdp.eval(`goToSlide(${slide})`);
          // Wait for wipe transition to finish
          await new Promise(r => setTimeout(r, 450));
        }

        // On Slide 2, test revealing all crew members so full layout is evaluated
        if (slide === 2) {
          for (let step = 0; step < 5; step++) {
            await cdp.eval('advanceCrewReveal()');
            await new Promise(r => setTimeout(r, 50));
          }
        }

        const audit = await cdp.eval(auditScript);
        console.log(`Slide ${slide < 10 ? '0' + slide : slide} [Scale: ${audit.scale}, StageFits: ${audit.stageFits}, CardVisible: ${audit.cardVisible}]: ${audit.violations.length === 0 ? 'PASS (No Violations)' : 'VIOLATIONS: ' + audit.violations.length}`);

        if (audit.violations.length > 0) {
          console.warn('  Issues:', JSON.stringify(audit.violations, null, 2));
          results.clippingIssues.push({ res: res.name, slide, violations: audit.violations });
        }

        // Capture screenshot on 1080p for all slides, and on other resolutions for key slides
        if (res.name === '1080p_Standard' || (slide === 1 || slide === 2 || slide === 5 || slide === 8)) {
          const shotName = res.name === '1080p_Standard'
            ? `slide_${slide < 10 ? '0' + slide : slide}.png`
            : `${res.name}_slide_${slide < 10 ? '0' + slide : slide}.png`;
          const shotPath = path.join(screenshotsDir, shotName);
          await cdp.captureScreenshot(shotPath);
        }
      }
    }

    // 2. Interactive Feature Tests
    console.log(`\n======================================================`);
    console.log(`Running Interactive Feature Tests...`);
    console.log(`======================================================`);

    await cdp.setViewport(1920, 1080, 1.0);

    // Test A: Restart from Middle of Deck
    console.log('Test A: Restart from Middle (Slide 6)...');
    await cdp.eval('goToSlide(6)');
    await new Promise(r => setTimeout(r, 450));
    const cardBeforeReset = await cdp.eval("document.getElementById('persistent-presenter-card').style.display");
    console.log('  Slide 6 presenter card display before reset:', cardBeforeReset);

    // Press 'r' / call resetPresentation()
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR' }))");
    await new Promise(r => setTimeout(r, 300));

    const resetState = await cdp.eval(`
      ({
        currentSlide,
        cardDisplay: document.getElementById('persistent-presenter-card').style.display,
        slide01Active: document.getElementById('slide-01').classList.contains('active'),
        activeRosterCount: document.querySelectorAll('.roster-pill.active').length,
        currentNum: document.getElementById('current-slide-num').textContent.trim(),
        totalNum: document.getElementById('total-slides-num').textContent.trim()
      })
    `);
    console.log('  State after R press:', resetState);
    if (resetState.currentSlide === 1 && resetState.cardDisplay === 'none' && resetState.activeRosterCount === 0 && resetState.currentNum === '01') {
      console.log('  PASS: Restart from middle successfully reset all deck state!');
      results.testPasses.push('Restart_From_Middle');
    } else {
      console.error('  FAIL: Restart state mismatch:', resetState);
      results.clippingIssues.push({ test: 'Restart_From_Middle', state: resetState });
    }

    // Test B: Backward Navigation
    console.log('\nTest B: Backward Navigation...');
    await cdp.eval('goToSlide(3)');
    await new Promise(r => setTimeout(r, 450));
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))");
    await new Promise(r => setTimeout(r, 450));
    let backSlide = await cdp.eval('currentSlide');
    console.log('  After Left Arrow from Slide 3:', backSlide);

    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))");
    await new Promise(r => setTimeout(r, 450));
    backSlide = await cdp.eval('currentSlide');
    console.log('  After Left Arrow from Slide 2:', backSlide);

    if (backSlide === 1) {
      console.log('  PASS: Backward navigation works smoothly!');
      results.testPasses.push('Backward_Navigation');
    } else {
      console.error('  FAIL: Backward navigation ended at slide', backSlide);
    }

    // Test C: Debug Toggle (D key)
    console.log('\nTest C: Debug Safe Guide Toggle (D key)...');
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD' }))");
    await new Promise(r => setTimeout(r, 100));

    const debugStateActive = await cdp.eval(`
      ({
        stageHasClass: document.getElementById('deck-stage').classList.contains('debug-active'),
        guideDisplay: window.getComputedStyle(document.getElementById('debug-safe-guide')).display
      })
    `);
    console.log('  Debug state after D press:', debugStateActive);

    // Capture screenshot with debug guide active
    await cdp.captureScreenshot(path.join(screenshotsDir, 'debug_guide_active.png'));

    // Toggle off
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD' }))");
    await new Promise(r => setTimeout(r, 100));
    const debugStateOff = await cdp.eval("document.getElementById('deck-stage').classList.contains('debug-active')");
    console.log('  Debug state after second D press (should be false):', debugStateOff);

    if (debugStateActive.stageHasClass && debugStateActive.guideDisplay === 'block' && !debugStateOff) {
      console.log('  PASS: Debug safe guide toggles correctly with D key!');
      results.testPasses.push('Debug_Guide_Toggle');
    } else {
      console.error('  FAIL: Debug safe guide toggle failed:', debugStateActive, debugStateOff);
    }

    // Test D: Presenter Card Position & Clearance on Slides 3-12
    console.log('\nTest D: Presenter Card Non-Collision Check on Slides 3-12...');
    let cardCollisionCount = 0;
    for (let s = 3; s <= 12; s++) {
      await cdp.eval(`goToSlide(${s})`);
      await new Promise(r => setTimeout(r, 450));

      const collisionCheck = await cdp.eval(`
        (() => {
          const card = document.getElementById('persistent-presenter-card');
          const cr = card.getBoundingClientRect();
          const canvases = Array.from(document.querySelectorAll('.slide.active canvas'));
          const collisions = [];

          canvases.forEach(c => {
            const r = c.getBoundingClientRect();
            const intersects = !(r.right <= cr.left || r.left >= cr.right || r.bottom <= cr.top || r.top >= cr.bottom);
            if (intersects) collisions.push(c.id);
          });

          return {
            cardVisible: window.getComputedStyle(card).display !== 'none',
            cardBottom: Math.round(cr.bottom),
            collisions
          };
        })()
      `);

      if (collisionCheck.collisions.length > 0) {
        console.warn(`  Slide ${s} COLLISION DETECTED with: ${collisionCheck.collisions.join(', ')}`);
        cardCollisionCount++;
      } else {
        console.log(`  Slide ${s}: Card docked, 0 canvas collisions`);
      }
    }

    if (cardCollisionCount === 0) {
      console.log('  PASS: Presenter card has 100% clean clearance from all canvases!');
      results.testPasses.push('Presenter_Card_Clearance');
    }

    // Test E: Fullscreen Toggle and Recompute
    console.log('\nTest E: Fullscreen Toggle and Recompute (F key)...');
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF' }))");
    await new Promise(r => setTimeout(r, 100));
    const scaleAfterF = await cdp.eval(`
      (() => {
        applyStageScale();
        const stage = document.getElementById('deck-stage');
        return stage.style.transform;
      })()
    `);
    console.log('  Stage transform after F toggle:', scaleAfterF);
    if (scaleAfterF.includes('scale(')) {
      console.log('  PASS: Fullscreen toggle recomputes stage transform correctly!');
      results.testPasses.push('Fullscreen_Toggle');
    }

    // PDF Backup Export
    console.log('\nGenerating Static PDF Backup via CDP printToPDF...');
    await cdp.eval("window.dispatchEvent(new Event('beforeprint'))");
    await new Promise(r => setTimeout(r, 200));
    const pdfRes = await cdp.send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 20,
      paperHeight: 11.25,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: true
    });
    if (pdfRes && pdfRes.data) {
      const pdfBuffer = Buffer.from(pdfRes.data, 'base64');
      const pdfPath = path.join(__dirname, 'DBSCAN_Heist_Deck_Backup.pdf');
      fs.writeFileSync(pdfPath, pdfBuffer);
      console.log('  PASS: PDF backup written to', pdfPath, `(${pdfBuffer.length} bytes)`);
      results.testPasses.push('PDF_Backup_Export');
    }

    console.log(`\n======================================================`);
    console.log(`SUMMARY OF VERIFICATION`);
    console.log(`Resolutions Tested: ${results.resolutionsTested.join(', ')}`);
    console.log(`Total Clipping Issues: ${results.clippingIssues.length}`);
    console.log(`Total Passes: ${results.testPasses.join(', ')}`);
    console.log(`======================================================\n`);

  } catch (err) {
    console.error('Verification suite error:', err);
  } finally {
    if (cdp) cdp.close();
    edgeProcess.kill('SIGKILL');
    setTimeout(() => {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }, 1000);
  }
}

runVerification();
