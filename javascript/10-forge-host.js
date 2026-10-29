// Forge Neo adapter: use native txt2img so sampler, scripts and model settings stay in sync.
(function () {
    'use strict';
    if (typeof onUiLoaded !== 'function') return;
    onUiLoaded(() => {
        const app = gradioApp();
        const root = app.querySelector('#forge-layout-editor');
        if (!root || root.dataset.mounted) return;
        root.dataset.mounted = 'true';
        const LE = window.LayoutEditor;
        const field = (id, selector = 'textarea, input') => app.querySelector('#' + id)?.querySelector(selector);
        const read = id => field(id)?.value || '';
        const write = (id, value) => {
            const input = field(id);
            if (!input) throw new Error('Forge control is missing: ' + id);
            input.value = String(value);
            updateInput(input);
        };
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const active = () => root.getClientRects().length > 0;
        const taskId = () => typeof localGet === 'function' ? localGet('txt2img_task_id') : null;
        const gallery = () => [...new Set([...app.querySelectorAll('#txt2img_gallery .thumbnail-item img')].map(img => img.src))];
        const loras = app.querySelector('#forge-layout-loras');
        const settings = app.querySelector('#forge-layout-settings');
        const extractLoras = prompt => (prompt.match(/<lora:[^>]+>/gi) || []).join(' ');
        try { loras.value = (localStorage.getItem('forge-layout.loras') ?? localStorage.getItem('forge-moss-layout.loras')) || extractLoras(read('txt2img_prompt')); } catch (_) { /* private storage */ }
        loras.addEventListener('input', () => {
            try { localStorage.setItem('forge-layout.loras', loras.value); } catch (_) { /* private storage */ }
        });
        let ownedTask = null;
        let starting = false;
        let editor;
        function checkedPrompt(model) {
            const errors = LE.validate(model).filter(issue => issue.level === 'error');
            if (errors.length) throw new Error(errors.map(issue => issue.message).join(' '));
            const obj = LE.getFormat(model.formatId).exportObject(model);
            LE.checkImport(obj);
            // Leave JSON literal: MOSS's native text engine disables emphasis.
            const tags = loras.value.trim();
            if (tags && !/^(?:<lora:[^<>\r\n]+>\s*)+$/i.test(tags)) throw new Error('LoRA tags must contain only <lora:name:weight> tags.');
            return JSON.stringify(obj) + (tags ? '\n' + tags : '');
        }
        function transfer(which, model) {
            const prompt = checkedPrompt(model);
            const widthInput = field(which + '_width');
            const heightInput = field(which + '_height');
            for (const [input, value] of [[widthInput, model.width], [heightInput, model.height]]) {
                if (!input) throw new Error('Forge resolution controls are unavailable.');
                if ((input.max && value > Number(input.max)) || (input.min && value < Number(input.min))) {
                    throw new Error('Canvas dimensions exceed the Forge resolution controls.');
                }
            }
            write(which + '_prompt', prompt);
            write(which + '_width', model.width);
            write(which + '_height', model.height);
            // Dynamic Prompts treats JSON braces as variants and strips them.
            // Turn off its native checkbox in this destination while it holds a layout.
            // This changes only the current browser controls, never saved defaults.
            const dynamic = app.querySelector('#tab_' + which + ' [id="sddp-dynamic-prompts-enabled"] input[type="checkbox"]');
            if (dynamic?.checked) dynamic.click();
            return prompt;
        }
        function send(which) {
            try {
                transfer(which, editor.model);
                if (which === 'txt2img') switch_to_txt2img();
                else switch_to_img2img();
                editor.toast('Layout and dimensions sent to ' + which + '.');
            } catch (error) { editor.toast(error.message, true); }
        }
        function importTxt2img() {
            const source = read('txt2img_prompt');
            const obj = LE.extractJsonObject(source);
            if (!obj || !Array.isArray(obj.items)) {
                editor.toast('txt2img does not contain a MOSS layout. Paste a draft in Prompt JSON or draw boxes.', true);
                return;
            }
            // Compiled prompts omit dimensions; use txt2img dimensions without mutating on failure.
            const base = LE.cloneModel(editor.model);
            base.width = Number(read('txt2img_width'));
            base.height = Number(read('txt2img_height'));
            try {
                const result = LE.getFormat('moss').importPrompt(source, base);
                editor.model = result.model;
                editor.selectedId = null;
                editor.renderAll();
                editor.commit();
                loras.value = extractLoras(source);
                loras.dispatchEvent(new Event('input'));
                editor.toast(result.notes.join(' ') || 'Loaded layout and dimensions from txt2img.');
            } catch (error) { editor.toast(error.message, true); }
        }
        async function generate(_prompt, model) {
            if (starting || editor.generating) return;
            starting = true;
            const before = gallery();
            try {
                // Refuse concurrent native work before modifying controls.
                const progress = await fetch('./internal/progress', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id_task: taskId() || 'forge-layout-idle-check', live_preview: false })
                });
                if (!progress.ok) throw new Error('Cannot read Forge generation status.');
                const status = await progress.json();
                const button = app.querySelector('#txt2img_generate');
                const interrupt = app.querySelector('#txt2img_interrupt');
                if (status.active || status.queued || !button || button.disabled || (interrupt && getComputedStyle(interrupt).display !== 'none')) {
                    throw new Error('Forge is already generating. Wait for the current job to finish.');
                }
                transfer('txt2img', model);
                if (editor.keepSeed && editor.lastSeed != null) write('txt2img_seed', editor.lastSeed);
                // Let Svelte flush the input events before native Gradio captures its inputs.
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const previousTask = taskId();
                editor.setGenStatus('Starting…', 0, true);
                button.click();
                const deadline = Date.now() + 15000;
                while ((!taskId() || taskId() === previousTask) && Date.now() < deadline) await delay(100);
                ownedTask = taskId();
                if (!ownedTask || ownedTask === previousTask) throw new Error('Forge did not start a txt2img job. Check the txt2img tab.');
                let seenActive = false;
                const queuedAt = Date.now();
                while (true) {
                    const response = await fetch('./internal/progress', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id_task: ownedTask, live_preview: false })
                    });
                    if (!response.ok) throw new Error('Forge progress request failed (' + response.status + ').');
                    const info = await response.json();
                    seenActive ||= info.active;
                    if (info.completed || (seenActive && !info.active && !info.queued)) break;
                    if (!seenActive && !info.queued && Date.now() - queuedAt > 45000) throw new Error('Generation did not enter the Forge queue. Check txt2img for an error.');
                    editor.setGenStatus(info.textinfo || (info.active ? 'Generating…' : 'Queued…'), info.progress, true);
                    await delay(900);
                }
                // Native progress can complete before Gradio has delivered gallery/metadata.
                let urls = [];
                for (let i = 0; i < 50; i++) {
                    urls = gallery().filter(src => !before.includes(src));
                    if (urls.length) break;
                    await delay(200);
                }
                let metadata = {};
                try { metadata = JSON.parse(read('generation_info_txt2img') || '{}'); } catch (_) { /* no result */ }
                const offset = metadata.index_of_first_image || 0;
                urls = urls.slice(offset);
                for (let i = urls.length - 1; i >= 0; i--) editor.addResult(urls[i], metadata.all_seeds?.[i] ?? metadata.seed);
                editor.setGenStatus(urls.length ? 'Done · ' + urls.length + ' image(s)' : 'No new image. Check txt2img for an error or interruption.', 1, false);
            } catch (error) {
                editor.setGenStatus('Generation stopped', null, false);
                editor.toast(error.message, true);
                console.error('[Forge Layout Editor]', error);
            } finally {
                ownedTask = null;
                starting = false;
            }
        }
        editor = new LE.Editor(root, {
            mode: 'forge', canGenerate: true, applyLabel: 'Send to txt2img',
            isActive: active,
            onApply: () => send('txt2img'),
            onGenerate: generate,
            async onInterrupt() {
                if (!ownedTask) return;
                // Interrupt only the native job this editor started, never another session's task.
                try {
                    const response = await fetch('./internal/progress', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id_task: ownedTask, live_preview: false })
                    });
                    if (!response.ok) throw new Error('Cannot check generation state.');
                    const state = await response.json();
                    if (state.active) app.querySelector('#txt2img_interrupt')?.click();
                    else editor.toast('This job is queued or already finished.');
                } catch (error) { editor.toast(error.message, true); }
            },
            extraToolbar(tools) {
                const button = (label, action) => {
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'le-btn'; b.textContent = label;
                    b.addEventListener('click', action); tools.appendChild(b);
                };
                button('Load txt2img', importTxt2img);
                button('Send to img2img', () => send('img2img'));
                button('Copy JSON', () => editor.copyPrompt());
                button('Save draft', () => {
                    try {
                        checkedPrompt(editor.model);
                        const draft = LE.toDraft(editor.model);
                        const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], {type: 'application/json'}));
                        const a = document.createElement('a'); a.href = url; a.download = 'forge-layout-draft.json'; a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch (error) { editor.toast(error.message, true); }
                });
            }
        });
        editor.workspace.addPanel('settings', 'Generation settings', app.querySelector('#forge-layout-host-options'));
        editor.applyButton.title = 'Send layout and canvas dimensions to txt2img';
        // A fresh canvas follows Forge; browser autosaved layouts retain their own size.
        if (!editor.model.items.length && !editor.model.scene.caption) {
            editor.setSize(Number(read('txt2img_width')) || 1024, Number(read('txt2img_height')) || 1024, false);
        }
        window.forgeLayoutEditor = { editor, send, importTxt2img, checkedPrompt };
        new ResizeObserver(() => { if (active()) editor.relayout(); }).observe(root);
        const refreshSettings = () => {
            if (!active()) return;
            const sampler = read('txt2img_sampling');
            const protectedJson = app.querySelector('#tab_txt2img [id="sddp-dynamic-prompts-enabled"] input')?.checked === false ? ' · Dynamic Prompts off' : '';
            settings.textContent = `txt2img: ${read('txt2img_steps')} steps · CFG ${read('txt2img_cfg_scale')} · ${sampler} / ${read('txt2img_scheduler')} · model selected above${protectedJson}`;
        };
        setInterval(refreshSettings, 1500);
        refreshSettings();
    });
})();
