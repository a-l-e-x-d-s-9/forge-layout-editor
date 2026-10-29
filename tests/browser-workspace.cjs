// Local by default. FORGE_URL may point to an isolated Forge test instance.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const artifacts=require('node:path').join(root,'test-results');
fs.mkdirSync(artifacts,{recursive:true});
const url = process.env.FORGE_URL || 'file://' + root + '/standalone/index.html';
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.stack));
        const prepare = async () => {
            await page.waitForFunction(() => !!(window.forgeLayoutEditor?.editor || window.layoutEditor)?.workspace);
            if (process.env.FORGE_URL) await page.getByRole('tab', { name: 'Forge Layout Editor', exact: true }).click();
            await page.evaluate(() => {
                const editor = window.forgeLayoutEditor?.editor || window.layoutEditor;
                window.workspaceTestEditor = editor;
                if (!editor.host.canGenerate) {
                    editor.resizeObserver.disconnect();
                    editor.workspace.captionObserver.disconnect();
                    editor.host.canGenerate = true;
                    editor.buildDom(); editor.renderAll();
                    const settings = document.createElement('div');
                    settings.textContent = 'Use the current txt2img generation settings.';
                    editor.workspace.addPanel('settings', 'Generation settings', settings);
                }
                // Check the real button binding without submitting a GPU job.
                window.workspaceTestGenerateCount = 0;
                editor.host.onGenerate = () => window.workspaceTestGenerateCount++;
            });
        };
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await prepare();
        await page.evaluate(draft => {
            workspaceTestEditor.importPrompt(JSON.stringify(draft));
            workspaceTestEditor.workspace.reset();
            workspaceTestEditor.selectedId = workspaceTestEditor.model.items[0].id;
        }, JSON.parse(fs.readFileSync(root + '/examples/layout-lab.json', 'utf8')));
        const modelBefore = await page.evaluate(() => JSON.stringify(workspaceTestEditor.model));
        const panel = id => page.locator('.le-workspace-panel[data-panel="' + id + '"]');
        const dragBy = async (locator, dx, dy) => {
            await locator.scrollIntoViewIfNeeded();
            const box = await locator.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
            await page.mouse.up();
        };
        const generate = page.locator('.le-generation-actions').getByRole('button', { name: 'Generate', exact: true });
        const genBox = await generate.boundingBox();
        const rootBox = await page.locator('.le-root').boundingBox();
        const toolsBox = await panel('tools').boundingBox();
        assert.ok(genBox.y < toolsBox.y, 'Generate is above the tools and canvas');
        assert.ok(rootBox.x + rootBox.width - genBox.x - genBox.width < 30, 'Generate is at the top right');
        assert.ok(genBox.height >= 46, 'Generate is a prominent button');
        await generate.click();
        assert.equal(await page.evaluate(() => workspaceTestGenerateCount), 1);
        console.log('PASS Generate at top right and original button binding');

        const beforeCanvas = await panel('canvas').boundingBox();
        const beforeArea = await page.locator('.le-stage-wrap').boundingBox();
        await dragBy(panel('canvas').getByRole('separator'), 0, 180);
        const grownCanvas = await panel('canvas').boundingBox();
        const grownArea = await page.locator('.le-stage-wrap').boundingBox();
        assert.ok(grownCanvas.height >= beforeCanvas.height + 175);
        assert.ok(grownArea.height >= beforeArea.height + 175);
        console.log('PASS visible bottom handle enlarges canvas area');

        const scene = page.getByRole('textbox', { name: 'Scene caption', exact: true });
        await scene.scrollIntoViewIfNeeded();
        const sceneBefore = await scene.boundingBox();
        const documentBefore = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.mouse.move(sceneBefore.x + sceneBefore.width - 3, sceneBefore.y + sceneBefore.height - 3);
        await page.mouse.down();
        await page.mouse.move(sceneBefore.x + sceneBefore.width - 3, sceneBefore.y + sceneBefore.height + 147, { steps: 12 });
        await page.mouse.up();
        const sceneAfter = await scene.boundingBox();
        assert.ok(sceneAfter.height >= sceneBefore.height + 140, 'native textarea handle grows caption');
        assert.ok(Math.abs((await panel('canvas').boundingBox()).height - grownCanvas.height) < 1, 'caption never shrinks canvas');
        assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) >= documentBefore + 130, 'extra caption space extends the page');
        console.log('PASS caption expands downward without taking canvas space');

        const initialWidth = (await panel('canvas').boundingBox()).width;
        await dragBy(panel('canvas').getByRole('button', { name: 'Resize Canvas width and height', exact: true }), 135, 30);
        assert.ok((await panel('canvas').boundingBox()).width > initialWidth + 80, 'corner widens canvas panel');
        const inspector = panel('inspector');
        const inspectorHeight = (await inspector.boundingBox()).height;
        await inspector.getByRole('separator').focus();
        await page.keyboard.press('ArrowDown');
        assert.ok((await inspector.boundingBox()).height >= inspectorHeight + 31);
        // Selected image boxes must not move when workspace keyboard controls are used.
        assert.equal(await page.evaluate(() => JSON.stringify(workspaceTestEditor.model)), modelBefore);
        console.log('PASS corner width/height and keyboard resizing preserve image geometry');

        await panel('checks').locator('.le-panel-header').dragTo(panel('scene').locator('.le-panel-header'));
        let order = await page.locator('.le-workspace-panel').evaluateAll(elements => elements.map(el => el.dataset.panel));
        assert.ok(order.indexOf('checks') < order.indexOf('scene'), 'header dragging reorders panels');
        await panel('settings').getByRole('button', { name: 'Move Generation settings panel' }).focus();
        await page.keyboard.press('Home');
        order = await page.locator('.le-workspace-panel').evaluateAll(elements => elements.map(el => el.dataset.panel));
        assert.equal(order[0], 'settings');
        assert.equal(await page.evaluate(() => JSON.stringify(workspaceTestEditor.model)), modelBefore);
        // A previous layer drag leaves a layer ID behind. A workspace drop over a
        // layer row must never reorder image items using that old ID.
        await page.evaluate(() => { workspaceTestEditor.dragLayerId = workspaceTestEditor.model.items[0].id; });
        await panel('checks').locator('.le-panel-header').dragTo(panel('layers').locator('.le-layer').last());
        assert.equal(await page.evaluate(() => JSON.stringify(workspaceTestEditor.model)), modelBefore);
        console.log('PASS panel dragging and keyboard reorder do not change prompts');

        // Wait for the native caption resize observer's preference write.
        await page.waitForTimeout(250);
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('forgeLayoutEditor.workspace.v1')));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await prepare();
        const restored = await page.evaluate(() => workspaceTestEditor.workspace.state);
        assert.deepEqual(restored.order, saved.order);
        assert.deepEqual(restored.panels, saved.panels);
        assert.ok(Math.abs(restored.captionHeight - saved.captionHeight) < 2);
        assert.equal(await page.evaluate(() => JSON.stringify(workspaceTestEditor.model)), modelBefore);
        console.log('PASS panel order, sizes and caption size survive reload');

        await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
        assert.equal(await page.locator('.le-workspace-panel').first().getAttribute('data-panel'), 'tools');
        assert.equal(Math.round((await panel('canvas').boundingBox()).height), 560);
        assert.equal(await page.evaluate(() => JSON.stringify(workspaceTestEditor.model)), modelBefore);
        await page.screenshot({ path: artifacts + '/workspace-update.png', fullPage: true });
        await page.setViewportSize({ width: 800, height: 1200 });
        assert.ok(await page.locator('.le-root').evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'narrow workspace has no horizontal overflow');
        const narrowWidth = (await page.locator('.le-root').boundingBox()).width;
        for (const id of ['layers', 'canvas', 'inspector', 'scene', 'checks', 'results', 'settings', 'json']) {
            const box = await panel(id).boundingBox();
            assert.ok(Math.abs(box.width - narrowWidth) < 3, id + ' stacks at narrow widths');
        }
        console.log('PASS Reset layout and responsive panels');
        assert.deepEqual(errors.filter(error => error.includes('/'+require('node:path').basename(root)+'/javascript/')), []);
        fs.writeFileSync(artifacts + '/workspace-test-results.json', JSON.stringify({ mode: process.env.FORGE_URL ? 'isolated Forge browser' : 'local standalone browser', passed: 7, errors }, null, 2));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
