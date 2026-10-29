// Layout Editor - the visual editor.
// Host-agnostic: SwarmUI and the standalone page both create an Editor and pass a `host` object.
//
// host = {
//   mode: 'swarm' | 'standalone',
//   canGenerate: bool,
//   applyLabel: string,                 // 'Apply' (Swarm) or 'Copy' (standalone)
//   onApply(prompt, model),             // Apply / Copy button
//   onGenerate(prompt, model),          // Generate button / Ctrl+Enter (only when canGenerate)
//   onInterrupt(),                      // Cancel button during generation
//   isActive() -> bool,                 // whether keyboard shortcuts should be handled right now
//   extraToolbar(el)                    // lets the host add its own buttons (maximize, close)
// }
(function () {
    'use strict';
    const LE = window.LayoutEditor = window.LayoutEditor || {};

    const STORAGE_AUTOSAVE = 'layoutEditor.autosave.v1';
    const STORAGE_SAVED = 'layoutEditor.saved.v1';
    const STORAGE_PREFS = 'layoutEditor.prefs.v1';
    const SNAP_SCREEN_PX = 7;
    const GRID = 16;
    const MIN_DRAW_SCREEN_PX = 6;

    function storageGet(key, fallback) {
        try {
            const v = window.localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        }
        catch (e) {
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        }
        catch (e) {
            // Storage can be unavailable (private mode, blocked site data); the editor still works without it.
        }
    }

    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                const v = attrs[k];
                if (v == null || v === false) {
                    continue;
                }
                if (k === 'class') {
                    e.className = v;
                }
                else if (k === 'text') {
                    e.textContent = v;
                }
                else if (k === 'html') {
                    e.innerHTML = v;
                }
                else if (k.startsWith('on')) {
                    e.addEventListener(k.substring(2), v);
                }
                else if (k === 'style' && typeof v === 'object') {
                    Object.assign(e.style, v);
                }
                else {
                    e.setAttribute(k, v === true ? '' : v);
                }
            }
        }
        for (const c of [].concat(children || [])) {
            if (c == null || c === false) {
                continue;
            }
            e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return e;
    }

    function isTypingTarget(t) {
        if (!t) {
            return false;
        }
        const tag = t.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }

    const TYPE_LETTER = { text: 'T', object: 'O', character: 'C' };

    class Editor {
        constructor(root, host) {
            this.root = root;
            this.host = Object.assign({
                mode: 'standalone',
                canGenerate: false,
                applyLabel: 'Copy',
                onApply() { },
                onGenerate() { },
                onInterrupt() { },
                isActive() { return true; },
                extraToolbar() { }
            }, host || {});
            this.prefs = Object.assign({ snap: true, grid: true, targetMp: 1.05, jsonOpen: false, underlayOpacity: 0.5 }, storageGet(STORAGE_PREFS, {}));
            this.model = LE.normalizeModel(storageGet(STORAGE_AUTOSAVE, null) || LE.newModel('moss'));
            this.selectedId = null;
            this.drawType = 'object';
            this.history = [JSON.stringify(this.model)];
            this.historyIndex = 0;
            this.underlay = null;
            this.results = [];
            this.generating = false;
            this.keepSeed = false;
            this.drag = null;
            this.scale = 1;
            this.buildDom();
            this.bindGlobalKeys();
            this.renderAll();
        }

        // ------------------------------------------------------------ selection
        // `selection` holds the selected box ids; the last one is the primary (shown in single-box views).

        get selectedId() {
            return this.selection && this.selection.length ? this.selection[this.selection.length - 1] : null;
        }

        set selectedId(id) {
            this.selection = id ? [id] : [];
        }

        isSelected(id) {
            return this.selection.includes(id);
        }

        selectedItems() {
            return this.model.items.filter(i => this.selection.includes(i.id));
        }

        setSelection(ids) {
            const seen = new Set();
            this.selection = ids.filter(id => !seen.has(id) && seen.add(id) && this.model.items.some(i => i.id === id));
            this.renderBoxes();
            this.renderLayers();
            this.renderInspector();
        }

        /** Ctrl/Cmd+click: add a box to the selection, or remove it. */
        toggleSelect(id) {
            const next = this.selection.slice();
            const i = next.indexOf(id);
            if (i === -1) {
                next.push(id);
            }
            else {
                next.splice(i, 1);
            }
            this.setSelection(next);
        }

        selectAll() {
            this.setSelection(this.model.items.filter(i => i.visible).map(i => i.id));
        }

        // ------------------------------------------------------------ public API

        getPrompt() {
            return LE.getFormat(this.model.formatId).exportPrompt(this.model);
        }

        getModel() {
            return this.model;
        }

        /** Replaces the canvas size (keeps relative box positions). */
        setSize(width, height, recordHistory) {
            this.model.width = LE.round16(width);
            this.model.height = LE.round16(height);
            this.renderAll();
            if (recordHistory !== false) {
                this.commit();
            }
        }

        /** Tries to load a prompt string. Returns true when it was recognized and imported. */
        importPrompt(str, silent) {
            for (const id of LE.formatOrder) {
                const profile = LE.formats[id];
                if (profile.detect(str)) {
                    try {
                        const res = profile.importPrompt(str, this.model);
                        this.model = res.model;
                        this.selectedId = null;
                        this.renderAll();
                        this.commit();
                        if (res.notes.length && !silent) {
                            this.toast(res.notes.join(' '));
                        }
                        return true;
                    }
                    catch (e) {
                        if (!silent) {
                            this.toast('Could not import: ' + e.message, true);
                        }
                        return false;
                    }
                }
            }
            return false;
        }

        setGenStatus(text, progress, running) {
            this.generating = !!running;
            if (!this.resultsBar) {
                return;
            }
            this.genStatusText.textContent = text || '';
            this.genProgress.style.width = progress == null ? '0%' : `${Math.round(progress * 100)}%`;
            this.genProgress.parentElement.style.visibility = running ? 'visible' : 'hidden';
            this.generateButton.style.display = running ? 'none' : '';
            this.cancelButton.style.display = running ? '' : 'none';
        }

        addResult(src, seed) {
            this.results.unshift({ src: src, seed: seed });
            if (this.results.length > 24) {
                this.results.length = 24;
            }
            if (seed != null) {
                this.lastSeed = seed;
            }
            this.renderResults();
            // The newest result becomes the underlay so boxes can be compared against it right away.
            this.setUnderlay(src, false);
        }

        focus() {
            this.stageWrap.focus({ preventScroll: true });
        }

        relayout() {
            this.layoutStage();
        }

        // ------------------------------------------------------------ DOM

        buildDom() {
            const r = this.root;
            r.innerHTML = '';
            r.classList.add('le-root');
            r.classList.toggle('le-mode-swarm', this.host.mode === 'swarm');

            // Toolbar
            this.formatSelect = el('select', { class: 'le-select', title: 'Output format', onchange: () => this.changeFormat(this.formatSelect.value) });
            for (const id of LE.formatOrder) {
                this.formatSelect.appendChild(el('option', { value: id, text: LE.formats[id].name }));
            }
            this.aspectSelect = el('select', { class: 'le-select', title: 'Aspect ratio', onchange: () => this.onAspectChange() });
            this.aspectSelect.appendChild(el('option', { value: 'custom', text: 'Custom' }));
            for (const a of LE.ASPECTS) {
                this.aspectSelect.appendChild(el('option', { value: a, text: a }));
            }
            this.mpSelect = el('select', { class: 'le-select', title: 'Target size for aspect presets', onchange: () => { this.prefs.targetMp = parseFloat(this.mpSelect.value); this.savePrefs(); this.onAspectChange(); } });
            for (const mp of [[1.05, '≈1 MP'], [1.5, '≈1.5 MP'], [2.1, '≈2 MP']]) {
                this.mpSelect.appendChild(el('option', { value: mp[0], text: mp[1] }));
            }
            this.mpSelect.value = String(this.prefs.targetMp);
            this.widthInput = el('input', { class: 'le-num', type: 'number', min: 256, max: 4096, step: 16, title: 'Width (px)', onchange: () => this.onSizeInput() });
            this.heightInput = el('input', { class: 'le-num', type: 'number', min: 256, max: 4096, step: 16, title: 'Height (px)', onchange: () => this.onSizeInput() });
            this.mpBadge = el('span', { class: 'le-badge' });
            this.typeButtons = el('div', { class: 'le-seg', title: 'Type for new boxes (keys T / O / C)' });
            this.addBoxButton = el('button', { class: 'le-btn le-add', title: 'Add a box of the selected type in a free spot (N). Useful when the canvas is full: you can also Shift-drag over boxes.', onclick: () => this.addBox() }, '+ Add');
            this.snapToggle = el('label', { class: 'le-check', title: 'Snap to edges, centers and other boxes (hold Alt to disable)' }, [
                el('input', { type: 'checkbox', onchange: e => { this.prefs.snap = e.target.checked; this.savePrefs(); } }), 'Snap'
            ]);
            this.gridToggle = el('label', { class: 'le-check', title: 'Snap to a 16 px grid' }, [
                el('input', { type: 'checkbox', onchange: e => { this.prefs.grid = e.target.checked; this.savePrefs(); } }), 'Grid 16'
            ]);
            this.underlayInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: e => this.loadUnderlayFile(e.target.files[0]) });
            this.underlayButton = el('button', { class: 'le-btn', title: 'Show an image under the boxes to trace or compare', onclick: () => this.underlay ? this.setUnderlay(null) : this.underlayInput.click() }, 'Underlay');
            this.underlayOpacity = el('input', { type: 'range', min: 0, max: 1, step: 0.05, class: 'le-range', title: 'Underlay opacity', oninput: e => { this.prefs.underlayOpacity = parseFloat(e.target.value); this.applyUnderlayOpacity(); this.savePrefs(); } });
            this.undoButton = el('button', { class: 'le-btn le-icon', title: 'Undo (Ctrl+Z)', onclick: () => this.undo() }, '↶');
            this.redoButton = el('button', { class: 'le-btn le-icon', title: 'Redo (Ctrl+Shift+Z)', onclick: () => this.redo() }, '↷');
            this.layoutsButton = el('button', { class: 'le-btn', title: 'New, save, load, export and import layouts', onclick: e => this.openLayoutsMenu(e) }, 'Layouts ▾');
            this.optionsButton = el('button', { class: 'le-btn', title: 'Format options', onclick: e => this.openOptionsMenu(e) }, 'Options ▾');
            this.hostTools = el('div', { class: 'le-host-tools' });
            this.applyButton = el('button', { class: 'le-btn le-primary-outline', title: this.host.mode === 'swarm' ? 'Write the layout into the prompt and close' : 'Copy the prompt to the clipboard', onclick: () => this.doApply() }, this.host.applyLabel);
            this.hostTools.appendChild(this.applyButton);
            this.host.extraToolbar(this.hostTools);

            const toolbar = el('div', { class: 'le-toolbar' }, [
                el('div', { class: 'le-group' }, [this.formatSelect]),
                el('div', { class: 'le-group' }, [this.aspectSelect, this.mpSelect, this.widthInput, el('span', { class: 'le-x', text: '×' }), this.heightInput, this.mpBadge]),
                el('div', { class: 'le-group' }, [this.addBoxButton, this.typeButtons]),
                el('div', { class: 'le-group' }, [this.snapToggle, this.gridToggle]),
                el('div', { class: 'le-group' }, [this.underlayButton, this.underlayOpacity, this.underlayInput]),
                el('div', { class: 'le-group' }, [this.undoButton, this.redoButton, this.layoutsButton, this.optionsButton]),
                el('div', { class: 'le-spacer' }),
                this.hostTools
            ]);

            // Layers
            this.layersList = el('div', { class: 'le-layers-list' });
            const layers = el('div', { class: 'le-panel le-layers' }, [
                el('div', { class: 'le-panel-title', text: 'Layers' }),
                this.layersList,
                el('div', { class: 'le-hint', text: 'Drag to reorder. Order = order of items in the prompt.' })
            ]);

            // Stage
            this.underlayImg = el('img', { class: 'le-underlay', alt: '' });
            this.boxesLayer = el('div', { class: 'le-boxes' });
            this.guidesLayer = el('div', { class: 'le-guides' });
            this.stage = el('div', { class: 'le-stage' }, [this.underlayImg, this.boxesLayer, this.guidesLayer]);
            this.stageWrap = el('div', { class: 'le-stage-wrap', tabindex: '0' }, [this.stage]);
            this.stage.addEventListener('pointerdown', e => this.onStagePointerDown(e));
            this.stage.addEventListener('dblclick', e => this.onStageDblClick(e));
            this.stage.addEventListener('contextmenu', e => e.preventDefault());
            this.stageWrap.addEventListener('pointerdown', e => {
                if (e.target === this.stageWrap) {
                    this.select(null);
                }
            });

            // Results (generation)
            if (this.host.canGenerate) {
                this.genStatusText = el('span', { class: 'le-gen-status' });
                this.genProgress = el('div', { class: 'le-progress-inner' });
                this.generateButton = el('button', { class: 'le-btn le-primary', title: 'Generate with the current layout (Ctrl+Enter)', onclick: () => this.doGenerate() }, 'Generate');
                this.cancelButton = el('button', { class: 'le-btn le-danger', title: 'Stop the current generation', style: { display: 'none' }, onclick: () => this.host.onInterrupt() }, 'Cancel');
                this.keepSeedBox = el('input', { type: 'checkbox', onchange: e => { this.keepSeed = e.target.checked; } });
                this.resultsStrip = el('div', { class: 'le-results-strip' });
                this.resultsBar = el('div', { class: 'le-results' }, [
                    el('div', { class: 'le-results-head' }, [
                        this.generateButton, this.cancelButton,
                        el('label', { class: 'le-check', title: 'Reuse the seed of the last result, to compare layout changes fairly' }, [this.keepSeedBox, 'Keep seed']),
                        el('div', { class: 'le-progress', style: { visibility: 'hidden' } }, [this.genProgress]),
                        this.genStatusText
                    ]),
                    this.resultsStrip
                ]);
            }
            const center = el('div', { class: 'le-center' }, [this.stageWrap, this.resultsBar || null]);

            // Inspector
            this.inspector = el('div', { class: 'le-panel le-inspector' });

            // Bottom: scene + issues + JSON
            this.sceneCaption = el('textarea', { class: 'le-textarea', rows: 2, oninput: () => { this.model.scene.caption = this.sceneCaption.value; this.changed(true); } });
            this.metaChips = el('div', { class: 'le-chips' });
            this.issuesList = el('div', { class: 'le-issues' });
            this.jsonText = el('textarea', { class: 'le-textarea le-mono', rows: 6, spellcheck: 'false', oninput: () => this.onJsonInput() });
            this.jsonError = el('div', { class: 'le-json-error' });
            this.jsonDetails = el('details', { class: 'le-json', ontoggle: () => { this.prefs.jsonOpen = this.jsonDetails.open; this.savePrefs(); } }, [
                el('summary', {}, [
                    el('span', { text: 'Prompt JSON' }),
                    el('span', { class: 'le-hint', text: ' (live; edit or paste a layout here to load it)' })
                ]),
                this.jsonText,
                el('div', { class: 'le-row' }, [
                    el('button', { class: 'le-btn', onclick: () => this.copyPrompt() }, 'Copy'),
                    this.jsonError
                ])
            ]);
            this.jsonDetails.open = !!this.prefs.jsonOpen;
            this.sceneLabel = el('div', { class: 'le-label' });
            const bottom = el('div', { class: 'le-bottom' }, [
                el('div', { class: 'le-scene' }, [this.sceneLabel, this.sceneCaption, this.metaChips]),
                el('div', { class: 'le-side' }, [
                    el('div', { class: 'le-label', text: 'Checks' }),
                    this.issuesList
                ]),
                this.jsonDetails
            ]);

            this.toastEl = el('div', { class: 'le-toast' });
            this.menuEl = null;
            this.workspace = new LE.Workspace(this, {
                tools: toolbar, layers, canvas: center, inspector: this.inspector,
                scene: bottom.querySelector('.le-scene'), checks: bottom.querySelector('.le-side'),
                json: this.jsonDetails, results: this.resultsBar
            });
            r.appendChild(this.toastEl);

            this.resizeObserver = new ResizeObserver(() => this.layoutStage());
            this.resizeObserver.observe(this.stageWrap);
        }

        // ------------------------------------------------------------ rendering

        renderAll() {
            const m = this.model;
            const profile = LE.getFormat(m.formatId);
            this.formatSelect.value = profile.id;
            this.widthInput.value = m.width;
            this.heightInput.value = m.height;
            const aspect = LE.describeAspect(m.width, m.height);
            const presetDims = LE.ASPECTS.includes(aspect) ? LE.dimsForAspect(aspect, this.prefs.targetMp) : null;
            this.aspectSelect.value = presetDims && presetDims.width === m.width && presetDims.height === m.height ? aspect : 'custom';
            const mp = LE.megapixels(m);
            this.mpBadge.textContent = `${aspect} · ${mp.toFixed(2)} MP`;
            this.mpBadge.className = 'le-badge ' + (mp < 0.25 || mp > 4 ? 'le-bad' : (mp < 0.95 || mp > 2.1 ? 'le-warn' : 'le-ok'));
            this.snapToggle.querySelector('input').checked = !!this.prefs.snap;
            this.gridToggle.querySelector('input').checked = !!this.prefs.grid;
            this.underlayOpacity.value = this.prefs.underlayOpacity;
            this.underlayOpacity.style.display = this.underlay ? '' : 'none';
            this.underlayButton.textContent = this.underlay ? 'Underlay \u2715' : 'Underlay';
            this.underlayButton.title = this.underlay ? 'Remove the underlay image' : 'Show an image under the boxes to trace or compare';
            this.renderTypeButtons();
            if (document.activeElement !== this.sceneCaption) {
                this.sceneCaption.value = m.scene.caption;
            }
            this.sceneCaption.placeholder = profile.scenePlaceholder;
            this.sceneLabel.textContent = profile.sceneLabel;
            this.renderMeta();
            this.layoutStage();
            this.renderLayers();
            this.renderInspector();
            this.renderOutput();
            this.undoButton.disabled = this.historyIndex <= 0;
            this.redoButton.disabled = this.historyIndex >= this.history.length - 1;
        }

        renderTypeButtons() {
            const profile = LE.getFormat(this.model.formatId);
            const types = profile.types(this.model);
            if (!types.find(t => t.id === this.drawType)) {
                this.drawType = 'object';
            }
            this.typeButtons.innerHTML = '';
            for (const t of types) {
                this.typeButtons.appendChild(el('button', {
                    class: `le-seg-btn le-type-${t.id}` + (t.id === this.drawType ? ' le-active' : ''),
                    title: `Draw ${t.label} boxes (${t.key.toUpperCase()})`,
                    onclick: () => { this.drawType = t.id; this.renderTypeButtons(); }
                }, [el('span', { class: 'le-type-dot' }), t.label]));
            }
        }

        renderMeta() {
            const profile = LE.getFormat(this.model.formatId);
            const meta = this.model.scene.meta;
            this.metaChips.innerHTML = '';
            this.metaChips.appendChild(el('span', { class: 'le-hint', text: 'Meta:' }));
            const all = profile.metaSuggestions.slice();
            for (const m of meta) {
                if (!all.includes(m)) {
                    all.push(m);
                }
            }
            for (const m of all) {
                const on = meta.includes(m);
                this.metaChips.appendChild(el('button', {
                    class: 'le-chip' + (on ? ' le-active' : ''),
                    onclick: () => {
                        const i = this.model.scene.meta.indexOf(m);
                        if (i === -1) {
                            this.model.scene.meta.push(m);
                        }
                        else {
                            this.model.scene.meta.splice(i, 1);
                        }
                        this.renderMeta();
                        this.changed();
                    }
                }, m));
            }
            const add = el('input', {
                class: 'le-chip-input', placeholder: '+ add', title: 'Add a custom meta tag, then press Enter',
                onkeydown: e => {
                    if (e.key === 'Enter' && add.value.trim()) {
                        const v = add.value.trim();
                        if (!this.model.scene.meta.includes(v)) {
                            this.model.scene.meta.push(v);
                        }
                        this.renderMeta();
                        this.changed();
                        e.preventDefault();
                    }
                }
            });
            this.metaChips.appendChild(add);
        }

        layoutStage() {
            const wrap = this.stageWrap;
            const availW = Math.max(50, wrap.clientWidth - 24);
            const availH = Math.max(50, wrap.clientHeight - 24);
            const m = this.model;
            this.scale = Math.min(availW / m.width, availH / m.height);
            this.stage.style.width = `${Math.round(m.width * this.scale)}px`;
            this.stage.style.height = `${Math.round(m.height * this.scale)}px`;
            this.stage.style.setProperty('--le-grid', `${GRID * this.scale}px`);
            this.renderBoxes();
        }

        renderBoxes() {
            const m = this.model;
            const layer = this.boxesLayer;
            layer.innerHTML = '';
            m.items.forEach((item, index) => {
                if (!item.visible) {
                    return;
                }
                const sel = this.isSelected(item.id);
                const box = el('div', {
                    class: `le-box le-type-${item.type}` + (sel ? ' le-selected' : '') + (item.locked ? ' le-locked' : ''),
                    'data-id': item.id
                });
                box.style.left = `${item.x * 100}%`;
                box.style.top = `${item.y * 100}%`;
                box.style.width = `${item.w * 100}%`;
                box.style.height = `${item.h * 100}%`;
                box.appendChild(el('div', { class: 'le-box-tag', text: `${index + 1} ${TYPE_LETTER[item.type] || '?'}` + (item.locked ? ' 🔒' : '') }));
                if (item.type === 'text' && item.text) {
                    const p = LE.itemPixels(m, item);
                    const fontImg = LE.clamp(LE.estimateFontPx(item.text, p.w, p.h) * 0.85, 4, 400);
                    box.appendChild(el('div', { class: 'le-box-text', text: item.text, style: { fontSize: `${Math.max(6, fontImg * this.scale)}px` } }));
                }
                else if (item.caption) {
                    box.appendChild(el('div', { class: 'le-box-caption', text: item.caption }));
                }
                else {
                    box.appendChild(el('div', { class: 'le-box-caption le-empty', text: 'Double-click to describe' }));
                }
                if (sel && this.selection.length === 1 && !item.locked) {
                    for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
                        box.appendChild(el('div', { class: `le-handle le-h-${dir}`, 'data-dir': dir }));
                    }
                }
                layer.appendChild(box);
            });
        }

        renderLayers() {
            const list = this.layersList;
            list.innerHTML = '';
            if (!this.model.items.length) {
                list.appendChild(el('div', { class: 'le-hint le-pad', text: 'No boxes yet.' }));
                return;
            }
            this.model.items.forEach((item, index) => {
                const row = el('div', {
                    class: 'le-layer' + (this.isSelected(item.id) ? ' le-active' : '') + (item.visible ? '' : ' le-hidden'),
                    draggable: 'true',
                    onclick: e => this.onLayerClick(e, item, index),
                    ondblclick: () => this.focusInspectorField(item),
                    ondragstart: e => { this.dragLayerId = item.id; e.dataTransfer.effectAllowed = 'move'; row.classList.add('le-dragging'); },
                    ondragend: () => row.classList.remove('le-dragging'),
                    ondragover: e => { if (this.workspace?.dragged) return; e.preventDefault(); row.classList.add('le-dragover'); },
                    ondragleave: () => row.classList.remove('le-dragover'),
                    ondrop: e => { if (this.workspace?.dragged) return; e.preventDefault(); row.classList.remove('le-dragover'); this.moveItemTo(this.dragLayerId, index); }
                }, [
                    el('span', { class: 'le-layer-num', text: String(index + 1) }),
                    el('span', { class: `le-type-dot le-type-${item.type}`, title: item.type }),
                    el('span', { class: 'le-layer-name', text: (item.type === 'text' && item.text ? `“${item.text.split('\n')[0]}” ` : '') + (item.caption || '(no caption)') }),
                    el('button', { class: 'le-mini', title: item.visible ? 'Hide (not exported)' : 'Show', onclick: e => { e.stopPropagation(); this.updateItem(item.id, { visible: !item.visible }); } }, item.visible ? '👁' : '–'),
                    el('button', { class: 'le-mini', title: item.locked ? 'Unlock' : 'Lock', onclick: e => { e.stopPropagation(); this.updateItem(item.id, { locked: !item.locked }); } }, item.locked ? '🔒' : '🔓')
                ]);
                list.appendChild(row);
            });
        }

        onLayerClick(e, item, index) {
            if (e.ctrlKey || e.metaKey) {
                this.toggleSelect(item.id);
            }
            else if (e.shiftKey && this.selectedId) {
                const from = this.model.items.findIndex(i => i.id === this.selectedId);
                const lo = Math.min(from, index), hi = Math.max(from, index);
                const range = this.model.items.slice(lo, hi + 1).map(i => i.id).filter(id => id !== this.selectedId);
                this.setSelection(range.concat([this.selectedId]));
            }
            else {
                this.select(item.id);
            }
        }

        renderInspector() {
            const ins = this.inspector;
            const item = this.selectedItem();
            const profile = LE.getFormat(this.model.formatId);
            ins.innerHTML = '';
            if (this.selection.length > 1) {
                this.renderMultiInspector(this.selectedItems());
                return;
            }
            if (!item) {
                ins.appendChild(el('div', { class: 'le-panel-title', text: 'Inspector' }));
                ins.appendChild(el('div', { class: 'le-help' }, [
                    el('p', { text: 'Drag on the canvas to draw a box of the selected type, or click + Add.' }),
                    el('table', { class: 'le-keys' }, [
                        ['T / O / C', 'Text / Object / Character type'],
                        ['N', 'Add a box of the selected type'],
                        ['Ctrl+click', 'Select several boxes'],
                        ['Ctrl-drag', 'Select boxes inside a rectangle'],
                        ['Ctrl+A', 'Select all boxes'],
                        ['Double-click', 'Edit a box on the canvas'],
                        ['Arrows', 'Nudge 1 px (Shift: 16 px)'],
                        ['Shift-drag', 'Draw over existing boxes (or lock the box below)'],
                        ['Alt-drag', 'Duplicate a box; Alt while dragging: no snapping'],
                        ['Shift+T / O / C', 'Change the selected boxes\' type'],
                        ['Ctrl+D', 'Duplicate'],
                        ['Delete', 'Delete the selected boxes'],
                        ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
                        ['Ctrl+Enter', this.host.canGenerate ? 'Generate' : this.host.applyLabel],
                        ['Esc', 'Deselect / leave a field']
                    ].map(kv => el('tr', {}, [el('td', {}, [el('kbd', { text: kv[0] })]), el('td', { text: kv[1] })])))
                ]));
                return;
            }
            const index = this.model.items.indexOf(item);
            ins.appendChild(el('div', { class: 'le-panel-title', text: `Box #${index + 1}` }));
            const types = profile.types(this.model);
            const seg = el('div', { class: 'le-seg le-full' });
            for (const t of types) {
                seg.appendChild(el('button', {
                    class: `le-seg-btn le-type-${t.id}` + (item.type === t.id ? ' le-active' : ''),
                    onclick: () => { this.updateItem(item.id, { type: t.id }); this.renderInspector(); }
                }, [el('span', { class: 'le-type-dot' }), t.label]));
            }
            if (!types.find(t => t.id === item.type)) {
                seg.appendChild(el('span', { class: 'le-hint', text: `(${item.type}: exported as ${profile.typeForExport(this.model, item)})` }));
            }
            ins.appendChild(el('div', { class: 'le-label', text: 'Type' }));
            ins.appendChild(seg);
            const fields = profile.itemFields(item.type);
            if (fields.includes('text')) {
                ins.appendChild(el('div', { class: 'le-label', text: 'Text to render' }));
                const ta = el('textarea', {
                    class: 'le-textarea le-field-text', rows: 3, placeholder: profile.textPlaceholder,
                    oninput: () => { item.text = ta.value; this.changed(true, { skipInspector: true }); },
                    onkeydown: e => this.fieldKeys(e, false)
                });
                ta.value = item.text;
                ins.appendChild(ta);
            }
            ins.appendChild(el('div', { class: 'le-label', text: item.type === 'text' ? 'Caption (how the text looks)' : 'Caption' }));
            const cap = el('textarea', {
                class: 'le-textarea le-field-caption', rows: 4, placeholder: profile.placeholder(item.type),
                oninput: () => { item.caption = cap.value; this.changed(true, { skipInspector: true }); },
                onkeydown: e => this.fieldKeys(e, true)
            });
            cap.value = item.caption;
            ins.appendChild(cap);
            ins.appendChild(el('div', { class: 'le-label', text: 'Position and size (px, from top-left)' }));
            const p = LE.itemPixels(this.model, item);
            const geo = el('div', { class: 'le-geo' });
            const mk = (label, key, value) => {
                const input = el('input', {
                    class: 'le-num', type: 'number', step: 1, value: value, 'data-geo': key,
                    onchange: () => this.onGeoInput(item.id)
                });
                return el('label', { class: 'le-geo-field' }, [el('span', { text: label }), input]);
            };
            geo.appendChild(mk('X', 'x', p.x1));
            geo.appendChild(mk('Y', 'y', p.y1));
            geo.appendChild(mk('W', 'w', p.w));
            geo.appendChild(mk('H', 'h', p.h));
            ins.appendChild(geo);
            ins.appendChild(el('div', { class: 'le-row le-wrap' }, [
                el('button', { class: 'le-btn', title: 'Duplicate (Ctrl+D)', onclick: () => this.duplicateSelected() }, 'Duplicate'),
                el('button', { class: 'le-btn', title: 'Move earlier in the prompt', onclick: () => this.moveItemTo(item.id, index - 1) }, '↑'),
                el('button', { class: 'le-btn', title: 'Move later in the prompt', onclick: () => this.moveItemTo(item.id, index + 1) }, '↓'),
                el('button', { class: 'le-btn', onclick: () => this.updateItem(item.id, { locked: !item.locked }) }, item.locked ? 'Unlock' : 'Lock'),
                el('button', { class: 'le-btn le-danger', title: 'Delete (Del)', onclick: () => this.deleteSelected() }, 'Delete')
            ]));
        }

        renderMultiInspector(items) {
            const ins = this.inspector;
            const profile = LE.getFormat(this.model.formatId);
            ins.appendChild(el('div', { class: 'le-panel-title', text: `${items.length} boxes selected` }));
            ins.appendChild(el('div', { class: 'le-hint', text: 'Drag any of them to move them together. Ctrl+click a box to add or remove it.' }));
            ins.appendChild(el('div', { class: 'le-label', text: 'Type' }));
            const seg = el('div', { class: 'le-seg le-full' });
            for (const t of profile.types(this.model)) {
                const all = items.every(i => i.type === t.id);
                seg.appendChild(el('button', {
                    class: `le-seg-btn le-type-${t.id}` + (all ? ' le-active' : ''),
                    title: `Make all selected boxes ${t.label}`,
                    onclick: () => { for (const i of items) { i.type = t.id; } this.changed(); }
                }, [el('span', { class: 'le-type-dot' }), t.label]));
            }
            ins.appendChild(seg);
            const btn = (label, title, fn, disabled) => el('button', { class: 'le-btn', title: title, disabled: disabled ? 'disabled' : null, onclick: fn }, label);
            ins.appendChild(el('div', { class: 'le-label', text: 'Align (to the selection)' }));
            ins.appendChild(el('div', { class: 'le-align-grid' }, [
                btn('Left', 'Align left edges', () => this.align('left')),
                btn('Center', 'Align horizontal centers', () => this.align('hcenter')),
                btn('Right', 'Align right edges', () => this.align('right')),
                btn('Top', 'Align top edges', () => this.align('top')),
                btn('Middle', 'Align vertical centers', () => this.align('vcenter')),
                btn('Bottom', 'Align bottom edges', () => this.align('bottom'))
            ]));
            ins.appendChild(el('div', { class: 'le-label', text: 'Distribute and size' }));
            ins.appendChild(el('div', { class: 'le-align-grid' }, [
                btn('Space H', 'Equal horizontal gaps (3+ boxes)', () => this.distribute('x'), items.length < 3),
                btn('Space V', 'Equal vertical gaps (3+ boxes)', () => this.distribute('y'), items.length < 3),
                btn('Center on canvas', 'Center the group on the canvas', () => this.centerGroup()),
                btn('Same width', 'Give all the width of the last selected box', () => this.matchSize('w')),
                btn('Same height', 'Give all the height of the last selected box', () => this.matchSize('h'))
            ]));
            const anyLocked = items.some(i => i.locked);
            const anyHidden = items.some(i => !i.visible);
            ins.appendChild(el('div', { class: 'le-row le-wrap' }, [
                btn('Duplicate', 'Duplicate (Ctrl+D)', () => this.duplicateSelected()),
                btn(anyLocked ? 'Unlock all' : 'Lock all', '', () => { for (const i of items) { i.locked = !anyLocked; } this.changed(); }),
                btn(anyHidden ? 'Show all' : 'Hide all', 'Hidden boxes are not exported', () => { for (const i of items) { i.visible = anyHidden; } this.changed(); }),
                el('button', { class: 'le-btn le-danger', title: 'Delete (Del)', onclick: () => this.deleteSelected() }, 'Delete')
            ]));
        }

        /** Pixel rectangles of the selected, unlocked boxes plus their bounding box. */
        groupRects() {
            const m = this.model;
            const rects = this.selectedItems().filter(i => !i.locked).map(i => ({ item: i, p: LE.itemPixels(m, i) }));
            if (!rects.length) {
                return null;
            }
            return {
                rects: rects,
                x1: Math.min(...rects.map(r => r.p.x1)), y1: Math.min(...rects.map(r => r.p.y1)),
                x2: Math.max(...rects.map(r => r.p.x2)), y2: Math.max(...rects.map(r => r.p.y2))
            };
        }

        align(mode) {
            const g = this.groupRects();
            if (!g) {
                return;
            }
            for (const r of g.rects) {
                let x = r.p.x1, y = r.p.y1;
                if (mode === 'left') { x = g.x1; }
                if (mode === 'right') { x = g.x2 - r.p.w; }
                if (mode === 'hcenter') { x = Math.round((g.x1 + g.x2 - r.p.w) / 2); }
                if (mode === 'top') { y = g.y1; }
                if (mode === 'bottom') { y = g.y2 - r.p.h; }
                if (mode === 'vcenter') { y = Math.round((g.y1 + g.y2 - r.p.h) / 2); }
                LE.setItemPixels(this.model, r.item, x, y, r.p.w, r.p.h);
            }
            this.changed();
        }

        distribute(axis) {
            const g = this.groupRects();
            if (!g || g.rects.length < 3) {
                return;
            }
            const lo = axis === 'x' ? 'x1' : 'y1', size = axis === 'x' ? 'w' : 'h';
            const sorted = g.rects.slice().sort((a, b) => a.p[lo] - b.p[lo]);
            const span = (axis === 'x' ? g.x2 - g.x1 : g.y2 - g.y1);
            const used = sorted.reduce((s, r) => s + r.p[size], 0);
            const gap = (span - used) / (sorted.length - 1);
            let pos = axis === 'x' ? g.x1 : g.y1;
            for (const r of sorted) {
                const v = Math.round(pos);
                LE.setItemPixels(this.model, r.item, axis === 'x' ? v : r.p.x1, axis === 'x' ? r.p.y1 : v, r.p.w, r.p.h);
                pos += r.p[size] + gap;
            }
            this.changed();
        }

        centerGroup() {
            const g = this.groupRects();
            if (!g) {
                return;
            }
            const dx = Math.round((this.model.width - (g.x2 - g.x1)) / 2) - g.x1;
            const dy = Math.round((this.model.height - (g.y2 - g.y1)) / 2) - g.y1;
            for (const r of g.rects) {
                LE.setItemPixels(this.model, r.item, r.p.x1 + dx, r.p.y1 + dy, r.p.w, r.p.h);
            }
            this.changed();
        }

        matchSize(dim) {
            const g = this.groupRects();
            const ref = this.model.items.find(i => i.id === this.selectedId);
            if (!g || !ref) {
                return;
            }
            const rp = LE.itemPixels(this.model, ref);
            for (const r of g.rects) {
                LE.setItemPixels(this.model, r.item, r.p.x1, r.p.y1, dim === 'w' ? rp.w : r.p.w, dim === 'h' ? rp.h : r.p.h);
            }
            this.changed();
        }

        /** Adds a box of the given (or current) type in a free spot near the center, then edits it. */
        addBox(type) {
            type = type || this.drawType;
            const m = this.model;
            const w = Math.max(GRID, Math.round(m.width * 0.4 / GRID) * GRID);
            const h = Math.max(GRID, Math.round(m.height * (type === 'text' ? 0.12 : 0.3) / GRID) * GRID);
            let x = Math.round((m.width - w) / 2 / GRID) * GRID;
            let y = Math.round((m.height - h) / 2 / GRID) * GRID;
            const taken = (px, py) => m.items.some(it => {
                const p = LE.itemPixels(m, it);
                return it.visible && Math.abs(p.x1 - px) < 8 && Math.abs(p.y1 - py) < 8;
            });
            for (let k = 0; k < 40 && taken(x, y); k++) {
                x += 2 * GRID;
                y += 2 * GRID;
                if (x + w > m.width || y + h > m.height) {
                    x = GRID * (k % 8);
                    y = GRID * (k % 8);
                }
            }
            const item = LE.newItem(type, 0, 0, 0, 0);
            LE.setItemPixels(m, item, x, y, w, h);
            m.items.push(item);
            this.selectedId = item.id;
            this.changed();
            this.focusInspectorField(item);
        }

        updateInspectorGeometry() {
            const item = this.selectedItem();
            if (!item) {
                return;
            }
            const p = LE.itemPixels(this.model, item);
            const vals = { x: p.x1, y: p.y1, w: p.w, h: p.h };
            for (const input of this.inspector.querySelectorAll('[data-geo]')) {
                if (document.activeElement !== input) {
                    input.value = vals[input.dataset.geo];
                }
            }
        }

        renderOutput() {
            const prompt = this.getPrompt();
            if (document.activeElement !== this.jsonText) {
                this.jsonText.value = prompt;
                this.jsonError.textContent = '';
            }
            const issues = LE.validate(this.model, { swarm: this.host.mode === 'swarm' });
            this.issuesList.innerHTML = '';
            const counts = { error: 0, warning: 0, info: 0 };
            for (const issue of issues) {
                counts[issue.level]++;
                this.issuesList.appendChild(el('div', {
                    class: `le-issue le-${issue.level}` + (issue.itemId ? ' le-clickable' : ''),
                    onclick: issue.itemId ? () => this.select(issue.itemId) : null
                }, [el('span', { class: 'le-issue-icon', text: issue.level === 'error' ? '✖' : issue.level === 'warning' ? '⚠' : 'ℹ' }), issue.message]));
            }
            if (!issues.length) {
                this.issuesList.appendChild(el('div', { class: 'le-issue le-ok', text: '✔ No problems found.' }));
            }
            this.applyButton.classList.toggle('le-has-errors', counts.error > 0);
        }

        renderResults() {
            if (!this.resultsStrip) {
                return;
            }
            this.resultsStrip.innerHTML = '';
            if (!this.results.length) {
                this.resultsStrip.appendChild(el('div', { class: 'le-hint le-pad', text: 'Results appear here. Click one to show it under the boxes.' }));
                return;
            }
            for (const r of this.results) {
                const img = el('img', {
                    class: 'le-thumb' + (this.underlay === r.src ? ' le-active' : ''),
                    src: r.src, title: (r.seed != null ? `Seed ${r.seed}. ` : '') + 'Click: show under the boxes. Double-click: open full size.',
                    onclick: () => this.setUnderlay(this.underlay === r.src ? null : r.src),
                    ondblclick: () => window.open(r.src, '_blank')
                });
                this.resultsStrip.appendChild(img);
            }
        }

        // ------------------------------------------------------------ state changes

        /** The selected box when exactly one is selected, otherwise null. */
        selectedItem() {
            if (this.selection.length !== 1) {
                return null;
            }
            return this.model.items.find(i => i.id === this.selection[0]) || null;
        }

        select(id) {
            if (id ? (this.selection.length === 1 && this.selection[0] === id) : this.selection.length === 0) {
                return;
            }
            this.setSelection(id ? [id] : []);
        }

        /** Call after any model change. `typing` debounces the history entry. */
        changed(typing, opts) {
            opts = opts || {};
            this.renderBoxes();
            this.renderLayers();
            if (!opts.skipInspector) {
                this.renderInspector();
            }
            this.renderOutput();
            if (typing) {
                clearTimeout(this.commitTimer);
                this.commitTimer = setTimeout(() => this.commit(), 500);
            }
            else {
                this.commit();
            }
        }

        commit() {
            clearTimeout(this.commitTimer);
            const snap = JSON.stringify(this.model);
            if (snap === this.history[this.historyIndex]) {
                return;
            }
            this.history.length = this.historyIndex + 1;
            this.history.push(snap);
            if (this.history.length > 200) {
                this.history.shift();
            }
            this.historyIndex = this.history.length - 1;
            storageSet(STORAGE_AUTOSAVE, this.model);
            this.undoButton.disabled = this.historyIndex <= 0;
            this.redoButton.disabled = true;
        }

        restore(snap) {
            this.model = LE.normalizeModel(JSON.parse(snap));
            this.selection = this.selection.filter(id => this.model.items.some(i => i.id === id));
            storageSet(STORAGE_AUTOSAVE, this.model);
            this.renderAll();
        }

        undo() {
            this.commit();
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.restore(this.history[this.historyIndex]);
            }
        }

        redo() {
            if (this.historyIndex < this.history.length - 1) {
                this.historyIndex++;
                this.restore(this.history[this.historyIndex]);
            }
        }

        updateItem(id, patch) {
            const item = this.model.items.find(i => i.id === id);
            if (!item) {
                return;
            }
            Object.assign(item, patch);
            this.changed();
        }

        moveItemTo(id, newIndex) {
            const items = this.model.items;
            const from = items.findIndex(i => i.id === id);
            if (from === -1) {
                return;
            }
            newIndex = LE.clamp(newIndex, 0, items.length - 1);
            if (from === newIndex) {
                return;
            }
            const [it] = items.splice(from, 1);
            items.splice(newIndex, 0, it);
            this.changed();
        }

        /** Copies each selected box (inserted right after its original); the copies become the selection. */
        cloneSelection(offsetPx) {
            const items = this.model.items;
            const sel = this.selectedItems();
            const copies = [];
            for (let k = sel.length - 1; k >= 0; k--) {
                const copy = Object.assign(LE.cloneModel(sel[k]), { id: LE.uid(), locked: false });
                if (offsetPx) {
                    copy.x = LE.clamp(copy.x + offsetPx / this.model.width, 0, 1 - copy.w);
                    copy.y = LE.clamp(copy.y + offsetPx / this.model.height, 0, 1 - copy.h);
                }
                items.splice(items.indexOf(sel[k]) + 1, 0, copy);
                copies.unshift(copy);
            }
            this.selection = copies.map(c => c.id);
            return copies;
        }

        duplicateSelected() {
            if (!this.selection.length) {
                return;
            }
            this.cloneSelection(GRID);
            this.changed();
        }

        deleteSelected() {
            const sel = this.selectedItems();
            if (!sel.length) {
                return;
            }
            const firstIdx = this.model.items.indexOf(sel[0]);
            this.model.items = this.model.items.filter(i => !this.selection.includes(i.id));
            const next = this.model.items[Math.min(firstIdx, this.model.items.length - 1)];
            this.selectedId = next && sel.length === 1 ? next.id : null;
            this.changed();
        }

        changeFormat(id) {
            this.model.formatId = id;
            this.renderAll();
            this.commit();
        }

        onAspectChange() {
            const a = this.aspectSelect.value;
            if (a === 'custom') {
                return;
            }
            const d = LE.dimsForAspect(a, this.prefs.targetMp);
            this.setSize(d.width, d.height);
        }

        onSizeInput() {
            const w = LE.clamp(LE.round16(parseInt(this.widthInput.value) || this.model.width), 256, 4096);
            const h = LE.clamp(LE.round16(parseInt(this.heightInput.value) || this.model.height), 256, 4096);
            this.setSize(w, h);
        }

        onGeoInput(id) {
            const item = this.model.items.find(i => i.id === id);
            if (!item) {
                return;
            }
            const vals = {};
            for (const input of this.inspector.querySelectorAll('[data-geo]')) {
                vals[input.dataset.geo] = parseInt(input.value) || 0;
            }
            LE.setItemPixels(this.model, item, vals.x, vals.y, Math.max(1, vals.w), Math.max(1, vals.h));
            this.changed(false, { skipInspector: true });
            this.updateInspectorGeometry();
        }

        onJsonInput() {
            clearTimeout(this.jsonTimer);
            this.jsonTimer = setTimeout(() => {
                const text = this.jsonText.value;
                if (text === this.getPrompt()) {
                    this.jsonError.textContent = '';
                    return;
                }
                const profile = LE.getFormat(this.model.formatId);
                try {
                    const res = profile.importPrompt(text, this.model);
                    this.model = res.model;
                    this.selectedId = null;
                    this.jsonError.textContent = res.notes.join(' ');
                    this.jsonError.classList.remove('le-bad');
                    this.renderAll();
                    this.commit();
                }
                catch (e) {
                    this.jsonError.textContent = 'Not applied: ' + e.message;
                    this.jsonError.classList.add('le-bad');
                }
            }, 600);
        }

        savePrefs() {
            storageSet(STORAGE_PREFS, this.prefs);
        }

        // ------------------------------------------------------------ underlay

        loadUnderlayFile(file) {
            if (!file) {
                return;
            }
            const reader = new FileReader();
            reader.onload = () => this.setUnderlay(reader.result);
            reader.readAsDataURL(file);
            this.underlayInput.value = '';
        }

        setUnderlay(src) {
            this.underlay = src || null;
            if (this.underlay) {
                this.underlayImg.src = this.underlay;
                this.underlayImg.style.display = 'block';
            }
            else {
                this.underlayImg.removeAttribute('src');
                this.underlayImg.style.display = 'none';
            }
            this.applyUnderlayOpacity();
            this.underlayOpacity.style.display = this.underlay ? '' : 'none';
            this.underlayButton.textContent = this.underlay ? 'Underlay \u2715' : 'Underlay';
            this.underlayButton.title = this.underlay ? 'Remove the underlay image' : 'Show an image under the boxes to trace or compare';
            this.renderResults();
        }

        applyUnderlayOpacity() {
            this.underlayImg.style.opacity = this.prefs.underlayOpacity;
        }

        // ------------------------------------------------------------ actions

        doApply() {
            this.commit();
            this.host.onApply(this.getPrompt(), this.model);
        }

        doGenerate() {
            if (!this.host.canGenerate || this.generating) {
                return;
            }
            this.commit();
            this.host.onGenerate(this.getPrompt(), this.model);
        }

        copyPrompt() {
            const text = this.getPrompt();
            const done = () => this.toast('Prompt copied to the clipboard.');
            const fallback = () => {
                const ta = el('textarea', { style: { position: 'fixed', left: '-9999px' } });
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                let ok = false;
                try {
                    ok = document.execCommand('copy');
                }
                catch (e) {
                    ok = false;
                }
                ta.remove();
                if (ok) {
                    done();
                }
                else {
                    this.toast('Copy failed: select the JSON below and copy it manually.', true);
                    this.jsonDetails.open = true;
                }
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done, fallback);
            }
            else {
                fallback();
            }
        }

        toast(message, bad) {
            this.toastEl.textContent = message;
            this.toastEl.classList.toggle('le-bad', !!bad);
            this.toastEl.classList.add('le-show');
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => this.toastEl.classList.remove('le-show'), bad ? 6000 : 3000);
        }

        // ------------------------------------------------------------ menus

        closeMenu() {
            if (this.menuEl) {
                this.menuEl.remove();
                this.menuEl = null;
                document.removeEventListener('pointerdown', this.menuCloser, true);
            }
        }

        openMenu(anchor, entries) {
            this.closeMenu();
            const menu = el('div', { class: 'le-menu' });
            for (const entry of entries) {
                if (entry === '-') {
                    menu.appendChild(el('div', { class: 'le-menu-sep' }));
                    continue;
                }
                if (entry.header) {
                    menu.appendChild(el('div', { class: 'le-menu-header', text: entry.header }));
                    continue;
                }
                if (entry.node) {
                    menu.appendChild(entry.node);
                    continue;
                }
                menu.appendChild(el('div', { class: 'le-menu-row' }, [
                    el('button', { class: 'le-menu-item', onclick: () => { this.closeMenu(); entry.action(); } }, entry.label),
                    entry.side ? el('button', { class: 'le-menu-side', title: entry.sideTitle, onclick: () => { this.closeMenu(); entry.side(); } }, entry.sideLabel) : null
                ]));
            }
            const rect = anchor.getBoundingClientRect();
            const rootRect = this.root.getBoundingClientRect();
            menu.style.left = `${rect.left - rootRect.left}px`;
            menu.style.top = `${rect.bottom - rootRect.top + 4}px`;
            this.root.appendChild(menu);
            this.menuEl = menu;
            this.menuCloser = e => {
                if (!menu.contains(e.target) && e.target !== anchor) {
                    this.closeMenu();
                }
            };
            setTimeout(() => document.addEventListener('pointerdown', this.menuCloser, true), 0);
        }

        openLayoutsMenu(e) {
            const saved = storageGet(STORAGE_SAVED, {});
            const names = Object.keys(saved).sort((a, b) => a.localeCompare(b));
            const entries = [
                { label: 'New layout', action: () => this.newLayout() },
                { label: 'Save as…', action: () => this.saveAs() },
                '-',
                { label: 'Export .json file', action: () => this.exportFile() },
                { label: 'Import .json file…', action: () => this.importFile() }
            ];
            if (names.length) {
                entries.push('-');
                entries.push({ header: 'Saved layouts' });
                for (const name of names) {
                    entries.push({
                        label: name, action: () => this.loadSaved(name),
                        side: () => this.deleteSaved(name), sideLabel: '✕', sideTitle: `Delete "${name}"`
                    });
                }
            }
            this.openMenu(e.currentTarget, entries);
        }

        openOptionsMenu(e) {
            const m = this.model;
            const entries = [];
            const check = (label, title, value, onChange) => el('label', { class: 'le-menu-check', title: title }, [
                el('input', { type: 'checkbox', checked: value ? 'checked' : null, onchange: ev => onChange(ev.target.checked) }), label
            ]);
            if (m.formatId === 'moss') {
                entries.push({ header: 'MOSS-Image' });
                entries.push({ node: check('Character type', 'Adds a Character box type. The "character" label comes from ComfyUI\'s MOSS-Image Layout Prompt node, not the official MOSS spec.', m.options.characterType, v => { m.options.characterType = v; this.renderAll(); this.commit(); }) });
                const canvasInput = el('input', { class: 'le-input', value: m.scene.canvas || 'single', onchange: ev => { m.scene.canvas = ev.target.value.trim() || 'single'; this.changed(); } });
                entries.push({ node: el('label', { class: 'le-menu-check', title: 'summary.canvas value. Leave as "single" unless you know the model accepts another value.' }, ['Canvas mode ', canvasInput]) });
            }
            entries.push({ header: 'Output' });
            entries.push({ node: check('Compact JSON', 'One line, fewer tokens. Uncheck for indented JSON.', m.options.compactJson, v => { m.options.compactJson = v; this.changed(); }) });
            this.openMenu(e.currentTarget, entries);
        }

        newLayout() {
            if (this.model.items.length && !window.confirm('Start a new layout? The current one stays in undo history.')) {
                return;
            }
            const fresh = LE.newModel(this.model.formatId);
            fresh.width = this.model.width;
            fresh.height = this.model.height;
            fresh.options = Object.assign({}, this.model.options);
            this.model = fresh;
            this.selectedId = null;
            this.renderAll();
            this.commit();
        }

        saveAs() {
            const name = window.prompt('Name for this layout:', this.lastSavedName || '');
            if (!name || !name.trim()) {
                return;
            }
            const saved = storageGet(STORAGE_SAVED, {});
            if (saved[name.trim()] && !window.confirm(`Replace the saved layout "${name.trim()}"?`)) {
                return;
            }
            saved[name.trim()] = this.model;
            storageSet(STORAGE_SAVED, saved);
            this.lastSavedName = name.trim();
            this.toast(`Saved "${name.trim()}".`);
        }

        loadSaved(name) {
            const saved = storageGet(STORAGE_SAVED, {});
            if (!saved[name]) {
                return;
            }
            this.model = LE.normalizeModel(saved[name]);
            this.selectedId = null;
            this.lastSavedName = name;
            this.renderAll();
            this.commit();
        }

        deleteSaved(name) {
            if (!window.confirm(`Delete the saved layout "${name}"?`)) {
                return;
            }
            const saved = storageGet(STORAGE_SAVED, {});
            delete saved[name];
            storageSet(STORAGE_SAVED, saved);
        }

        exportFile() {
            const data = JSON.stringify({ layoutEditor: 1, model: this.model, prompt: this.getPrompt() }, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const a = el('a', { href: URL.createObjectURL(blob), download: `${(this.lastSavedName || 'layout').replace(/[^\w.-]+/g, '_')}.json` });
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }

        importFile() {
            const input = el('input', { type: 'file', accept: '.json,application/json,.txt' });
            input.onchange = () => {
                const file = input.files[0];
                if (!file) {
                    return;
                }
                file.text().then(text => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    }
                    catch (e) {
                        parsed = null;
                    }
                    if (parsed && parsed.layoutEditor && parsed.model) {
                        this.model = LE.normalizeModel(parsed.model);
                        this.selectedId = null;
                        this.renderAll();
                        this.commit();
                        this.toast(`Loaded ${file.name}.`);
                    }
                    else if (!this.importPrompt(text)) {
                        this.toast(`${file.name} is not a layout this editor recognizes.`, true);
                    }
                });
            };
            input.click();
        }

        focusInspectorField(item) {
            this.select(item.id);
            const field = this.inspector.querySelector(item.type === 'text' ? '.le-field-text' : '.le-field-caption');
            if (field) {
                field.focus();
                field.setSelectionRange(field.value.length, field.value.length);
            }
        }

        /** Enter in a caption commits and returns to the canvas; Esc always returns to the canvas. */
        fieldKeys(e, enterCommits) {
            if (e.key === 'Escape' || (enterCommits && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                this.commit();
                this.focus();
            }
        }

        // ------------------------------------------------------------ keyboard

        bindGlobalKeys() {
            this.keyHandler = e => {
                if (!this.root.isConnected || !this.host.isActive()) {
                    return;
                }
                const typing = isTypingTarget(e.target);
                const insideEditor = this.root.contains(e.target) || e.target === document.body;
                const ctrl = e.ctrlKey || e.metaKey;
                if (ctrl && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (document.activeElement && document.activeElement.classList.contains('le-inline-edit')) {
                        document.activeElement.blur();
                    }
                    if (this.host.canGenerate) {
                        this.doGenerate();
                    }
                    else {
                        this.doApply();
                    }
                    return;
                }
                if (typing || !insideEditor || e.target.closest?.('.le-panel-move, .le-panel-height-handle, .le-panel-resize-corner')) {
                    return;
                }
                const key = e.key.toLowerCase();
                if (ctrl && key === 'z') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.shiftKey) {
                        this.redo();
                    }
                    else {
                        this.undo();
                    }
                    return;
                }
                if (ctrl && key === 'y') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.redo();
                    return;
                }
                if (ctrl && key === 'd') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.duplicateSelected();
                    return;
                }
                if (ctrl && key === 'a') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.selectAll();
                    return;
                }
                if (ctrl || e.altKey) {
                    return;
                }
                if (key === 'n' || key === '+') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.addBox();
                    return;
                }
                const types = LE.getFormat(this.model.formatId).types(this.model);
                const t = types.find(t => t.key === key);
                if (t) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.drawType = t.id;
                    this.renderTypeButtons();
                    if (e.shiftKey && this.selection.length) {
                        for (const it of this.selectedItems()) {
                            it.type = t.id;
                        }
                        this.changed();
                    }
                    return;
                }
                if (key === 'delete' || key === 'backspace') {
                    if (this.selection.length) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.deleteSelected();
                    }
                    return;
                }
                if (key === 'escape') {
                    if (this.selection.length) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.select(null);
                    }
                    return;
                }
                if (key === 'enter') {
                    const item = this.selectedItem();
                    if (item) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.focusInspectorField(item);
                    }
                    return;
                }
                const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
                if (arrows[key]) {
                    const movable = this.selectedItems().filter(i => !i.locked);
                    if (!movable.length) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    const step = e.shiftKey ? GRID : 1;
                    for (const item of movable) {
                        const p = LE.itemPixels(this.model, item);
                        LE.setItemPixels(this.model, item, p.x1 + arrows[key][0] * step, p.y1 + arrows[key][1] * step, p.w, p.h);
                    }
                    this.renderBoxes();
                    this.updateInspectorGeometry();
                    this.renderOutput();
                    clearTimeout(this.commitTimer);
                    this.commitTimer = setTimeout(() => this.commit(), 400);
                }
            };
            document.addEventListener('keydown', this.keyHandler, true);
        }

        // ------------------------------------------------------------ pointer: draw, move, resize

        clientToImage(e) {
            const rect = this.stage.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) / this.scale,
                y: (e.clientY - rect.top) / this.scale
            };
        }

        /** Snap candidates along one axis: canvas edges and center, plus other boxes' edges and centers. */
        snapTargets(axis, excludeId) {
            const m = this.model;
            const size = axis === 'x' ? m.width : m.height;
            const t = [0, size / 2, size];
            const exclude = Array.isArray(excludeId) ? excludeId : [excludeId];
            for (const it of m.items) {
                if (exclude.includes(it.id) || !it.visible) {
                    continue;
                }
                const p = LE.itemPixels(m, it);
                if (axis === 'x') {
                    t.push(p.x1, p.x2, (p.x1 + p.x2) / 2);
                }
                else {
                    t.push(p.y1, p.y2, (p.y1 + p.y2) / 2);
                }
            }
            return t;
        }

        /**
         * Snaps a set of candidate values on one axis (e.g. left, center, right of a moving box).
         * Returns { delta, guide } where delta is the correction to apply (image px).
         */
        snapAxis(values, axis, excludeId, noSnap) {
            if (noSnap) {
                return { delta: 0, guide: null };
            }
            const threshold = SNAP_SCREEN_PX / this.scale;
            let best = null;
            if (this.prefs.snap) {
                for (const target of this.snapTargets(axis, excludeId)) {
                    for (const v of values) {
                        const d = target - v;
                        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) {
                            best = { delta: d, guide: target };
                        }
                    }
                }
            }
            if (best) {
                return best;
            }
            if (this.prefs.grid) {
                const v = values[0];
                return { delta: Math.round(v / GRID) * GRID - v, guide: null };
            }
            return { delta: 0, guide: null };
        }

        showGuides(gx, gy) {
            this.guidesLayer.innerHTML = '';
            if (gx != null) {
                this.guidesLayer.appendChild(el('div', { class: 'le-guide le-guide-v', style: { left: `${gx * this.scale}px` } }));
            }
            if (gy != null) {
                this.guidesLayer.appendChild(el('div', { class: 'le-guide le-guide-h', style: { top: `${gy * this.scale}px` } }));
            }
        }

        onStagePointerDown(e) {
            if (e.button !== 0) {
                return;
            }
            this.closeMenu();
            if (isTypingTarget(document.activeElement)) {
                document.activeElement.blur();
            }
            this.focus();
            const m = this.model;
            const pt = this.clientToImage(e);
            const handle = e.target.closest('.le-handle');
            const boxEl = e.target.closest('.le-box');
            if (e.target.closest('.le-inline-edit')) {
                return;
            }
            e.preventDefault();
            const ctrl = e.ctrlKey || e.metaKey;
            const hit = boxEl ? m.items.find(i => i.id === boxEl.dataset.id) : null;
            if (handle && hit && !ctrl) {
                this.drag = { mode: 'resize', dir: handle.dataset.dir, id: hit.id, start: pt, orig: LE.itemPixels(m, hit) };
            }
            else if (hit && ctrl) {
                // Ctrl/Cmd+click adds or removes a box; dragging right away moves the whole selection.
                this.toggleSelect(hit.id);
                if (!this.isSelected(hit.id)) {
                    return;
                }
                this.drag = this.makeGroupMove(pt, false);
            }
            else if (hit && !e.shiftKey && !hit.locked) {
                // Locked boxes and Shift-drag let you draw new boxes on top of existing ones.
                if (!this.isSelected(hit.id)) {
                    this.select(hit.id);
                }
                if (e.altKey) {
                    // Alt-drag duplicates, like in most design tools.
                    this.cloneSelection(0);
                    this.renderLayers();
                }
                this.drag = this.makeGroupMove(pt, e.altKey);
                this.drag.clickedId = e.altKey ? null : hit.id;
            }
            else if (ctrl) {
                // Ctrl-drag on empty canvas: rectangle selection, added to the current one.
                this.drag = { mode: 'marquee', start: pt, base: this.selection.slice() };
            }
            else {
                this.select(null);
                this.drag = { mode: 'draw', start: pt, id: null, type: this.drawType };
            }
            if (!this.drag) {
                return;
            }
            this.drag.moved = false;
            this.stage.setPointerCapture(e.pointerId);
            this.moveHandler = ev => this.onPointerMove(ev);
            this.upHandler = ev => this.onPointerUp(ev);
            this.stage.addEventListener('pointermove', this.moveHandler);
            this.stage.addEventListener('pointerup', this.upHandler);
            this.stage.addEventListener('pointercancel', this.upHandler);
        }

        makeGroupMove(pt, altStarted) {
            const g = this.groupRects();
            if (!g) {
                return null;
            }
            const origs = {};
            for (const r of g.rects) {
                origs[r.item.id] = r.p;
            }
            return { mode: 'move', ids: Object.keys(origs), origs: origs, bbox: g, start: pt, altStarted: altStarted };
        }

        onPointerMove(e) {
            const d = this.drag;
            if (!d) {
                return;
            }
            const m = this.model;
            const pt = this.clientToImage(e);
            const noSnap = e.altKey && d.mode !== 'move';
            const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
            if (!d.moved && Math.hypot(dx, dy) * this.scale < 3) {
                return;
            }
            d.moved = true;
            let gx = null, gy = null;
            if (d.mode === 'draw') {
                if (!d.id && Math.hypot(dx, dy) * this.scale < MIN_DRAW_SCREEN_PX) {
                    return;
                }
                const sx = this.snapAxis([d.start.x], 'x', d.id, noSnap);
                const sy = this.snapAxis([d.start.y], 'y', d.id, noSnap);
                const x0 = d.start.x + sx.delta, y0 = d.start.y + sy.delta;
                const ex = this.snapAxis([pt.x], 'x', d.id, noSnap);
                const ey = this.snapAxis([pt.y], 'y', d.id, noSnap);
                let x1 = LE.clamp(pt.x + ex.delta, 0, m.width), y1 = LE.clamp(pt.y + ey.delta, 0, m.height);
                gx = ex.guide; gy = ey.guide;
                const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
                const rw = Math.max(1, Math.abs(x1 - x0)), rh = Math.max(1, Math.abs(y1 - y0));
                if (!d.id) {
                    const item = LE.newItem(d.type, 0, 0, 0, 0);
                    m.items.push(item);
                    d.id = item.id;
                    this.selectedId = item.id;
                }
                const item = m.items.find(i => i.id === d.id);
                LE.setItemPixels(m, item, Math.round(rx), Math.round(ry), Math.round(rw), Math.round(rh));
            }
            else if (d.mode === 'move') {
                const b = d.bbox;
                const bw = b.x2 - b.x1, bh = b.y2 - b.y1;
                let nx = b.x1 + dx, ny = b.y1 + dy;
                const free = e.altKey && !d.altStarted;
                const sx = this.snapAxis([nx, nx + bw / 2, nx + bw], 'x', d.ids, free);
                const sy = this.snapAxis([ny, ny + bh / 2, ny + bh], 'y', d.ids, free);
                nx += sx.delta; ny += sy.delta;
                gx = sx.guide; gy = sy.guide;
                nx = LE.clamp(nx, 0, m.width - bw);
                ny = LE.clamp(ny, 0, m.height - bh);
                const offX = Math.round(nx - b.x1), offY = Math.round(ny - b.y1);
                for (const id of d.ids) {
                    const o = d.origs[id];
                    const item = m.items.find(i => i.id === id);
                    if (item) {
                        LE.setItemPixels(m, item, o.x1 + offX, o.y1 + offY, o.w, o.h);
                    }
                }
            }
            else if (d.mode === 'marquee') {
                const x1 = Math.min(d.start.x, pt.x), y1 = Math.min(d.start.y, pt.y);
                const x2 = Math.max(d.start.x, pt.x), y2 = Math.max(d.start.y, pt.y);
                const inside = m.items.filter(it => {
                    if (!it.visible) {
                        return false;
                    }
                    const p = LE.itemPixels(m, it);
                    return p.x1 < x2 && p.x2 > x1 && p.y1 < y2 && p.y2 > y1;
                }).map(it => it.id);
                this.selection = d.base.concat(inside.filter(id => !d.base.includes(id)));
                this.renderBoxes();
                this.showGuides(null, null);
                this.guidesLayer.appendChild(el('div', {
                    class: 'le-marquee',
                    style: { left: `${x1 * this.scale}px`, top: `${y1 * this.scale}px`, width: `${(x2 - x1) * this.scale}px`, height: `${(y2 - y1) * this.scale}px` }
                }));
                return;
            }
            else if (d.mode === 'resize') {
                const o = d.orig;
                let x1 = o.x1, y1 = o.y1, x2 = o.x2, y2 = o.y2;
                if (d.dir.includes('w')) {
                    const s = this.snapAxis([o.x1 + dx], 'x', d.id, noSnap);
                    x1 = LE.clamp(o.x1 + dx + s.delta, 0, x2 - 1); gx = s.guide;
                }
                if (d.dir.includes('e')) {
                    const s = this.snapAxis([o.x2 + dx], 'x', d.id, noSnap);
                    x2 = LE.clamp(o.x2 + dx + s.delta, x1 + 1, m.width); gx = s.guide;
                }
                if (d.dir.includes('n')) {
                    const s = this.snapAxis([o.y1 + dy], 'y', d.id, noSnap);
                    y1 = LE.clamp(o.y1 + dy + s.delta, 0, y2 - 1); gy = s.guide;
                }
                if (d.dir.includes('s')) {
                    const s = this.snapAxis([o.y2 + dy], 'y', d.id, noSnap);
                    y2 = LE.clamp(o.y2 + dy + s.delta, y1 + 1, m.height); gy = s.guide;
                }
                const item = m.items.find(i => i.id === d.id);
                LE.setItemPixels(m, item, Math.round(x1), Math.round(y1), Math.round(x2 - x1), Math.round(y2 - y1));
            }
            this.showGuides(gx, gy);
            this.renderBoxes();
            this.updateInspectorGeometry();
        }

        onPointerUp(e) {
            const d = this.drag;
            this.drag = null;
            this.stage.removeEventListener('pointermove', this.moveHandler);
            this.stage.removeEventListener('pointerup', this.upHandler);
            this.stage.removeEventListener('pointercancel', this.upHandler);
            try {
                this.stage.releasePointerCapture(e.pointerId);
            }
            catch (err) {
                // Capture may already be gone.
            }
            this.showGuides(null, null);
            if (d && !d.moved && d.mode === 'move' && d.clickedId && this.selection.length > 1) {
                this.select(d.clickedId);
                return;
            }
            if (!d || !d.moved) {
                return;
            }
            if (d.mode === 'marquee') {
                this.setSelection(this.selection);
                return;
            }
            if (d.mode === 'draw') {
                if (!d.id) {
                    return;
                }
                const item = this.model.items.find(i => i.id === d.id);
                const p = LE.itemPixels(this.model, item);
                if (p.w * this.scale < MIN_DRAW_SCREEN_PX || p.h * this.scale < MIN_DRAW_SCREEN_PX) {
                    this.model.items.splice(this.model.items.indexOf(item), 1);
                    this.selectedId = null;
                    this.changed();
                    return;
                }
                this.changed();
                // Draw, type, Enter, draw the next one: jump straight into the box's main field.
                this.focusInspectorField(item);
                return;
            }
            this.changed();
        }

        onStageDblClick(e) {
            if (e.target.closest('.le-inline-edit')) {
                return;
            }
            // The first click re-renders the boxes, so the event target may be stale: hit-test the point instead.
            const hit = document.elementFromPoint(e.clientX, e.clientY);
            const boxEl = hit ? hit.closest('.le-box') : null;
            if (!boxEl) {
                return;
            }
            const item = this.model.items.find(i => i.id === boxEl.dataset.id);
            if (!item) {
                return;
            }
            e.preventDefault();
            this.select(item.id);
            this.startInlineEdit(item);
        }

        /** Edits a box's main field directly on the canvas: the text for text boxes, the caption otherwise. */
        startInlineEdit(item) {
            const boxEl = this.boxesLayer.querySelector(`.le-box[data-id="${item.id}"]`);
            if (!boxEl) {
                return;
            }
            const field = item.type === 'text' ? 'text' : 'caption';
            const ta = el('textarea', {
                class: 'le-inline-edit',
                placeholder: field === 'text' ? 'Text to render…' : 'Describe this box…'
            });
            ta.value = item[field];
            let done = false;
            const finish = (save) => {
                if (done) {
                    return;
                }
                done = true;
                if (save) {
                    item[field] = ta.value;
                }
                this.changed();
                this.focus();
            };
            ta.addEventListener('keydown', ev => {
                ev.stopPropagation();
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    finish(false);
                }
                else if (ev.key === 'Enter' && field === 'caption' && !ev.shiftKey) {
                    ev.preventDefault();
                    finish(true);
                }
                else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                    ev.preventDefault();
                    finish(true);
                }
            });
            ta.addEventListener('blur', () => finish(true));
            ta.addEventListener('pointerdown', ev => ev.stopPropagation());
            boxEl.appendChild(ta);
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    }

    LE.Editor = Editor;
})();

// Movable, independently sized editor panels. UI preferences never change image geometry.
(function () {
    'use strict';
    const LE = window.LayoutEditor;
    const STORAGE = 'forgeLayoutEditor.workspace.v1';
    const DEFAULTS = {
        tools:     { span: 12, height: 100, minSpan: 4, minHeight: 90 },
        layers:    { span: 2, height: 560, minSpan: 2, minHeight: 160, bounded: true },
        canvas:    { span: 7, height: 560, minSpan: 3, minHeight: 240, bounded: true },
        inspector: { span: 3, height: 560, minSpan: 2, minHeight: 180, bounded: true },
        scene:     { span: 8, height: 170, minSpan: 3, minHeight: 150 },
        checks:    { span: 4, height: 170, minSpan: 2, minHeight: 120 },
        results:   { span: 8, height: 150, minSpan: 3, minHeight: 130, bounded: true },
        settings:  { span: 4, height: 150, minSpan: 3, minHeight: 120 },
        json:      { span: 12, height: 100, minSpan: 4, minHeight: 90 }
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function node(tag, className, text) {
        const element = document.createElement(tag);
        element.className = className;
        if (text) element.textContent = text;
        return element;
    }
    function load() {
        let raw;
        try { raw = JSON.parse(localStorage.getItem(STORAGE) ?? localStorage.getItem('forgeMossLayout.workspace.v1')); } catch (_) { /* storage unavailable */ }
        const state = { order: Object.keys(DEFAULTS), panels: {}, captionHeight: 80 };
        if (!raw || typeof raw !== 'object') return state;
        if (Array.isArray(raw.order)) state.order = [...new Set([...raw.order.filter(id => Object.hasOwn(DEFAULTS, id)), ...state.order])];
        for (const [id, defaults] of Object.entries(DEFAULTS)) {
            const saved = raw.panels?.[id];
            if (!saved || typeof saved !== 'object') continue;
            state.panels[id] = {
                span: Number.isFinite(saved.span) ? clamp(Math.round(saved.span), defaults.minSpan, 12) : defaults.span,
                height: Number.isFinite(saved.height) ? clamp(saved.height, defaults.minHeight, 4000) : defaults.height
            };
        }
        if (Number.isFinite(raw.captionHeight)) state.captionHeight = clamp(raw.captionHeight, 72, 3500);
        return state;
    }

    class Workspace {
        constructor(editor, parts) {
            this.editor = editor;
            this.state = load();
            this.panels = new Map();
            this.dragged = null;
            const header = node('div', 'le-workspace-top');
            const intro = node('div', 'le-workspace-intro');
            intro.append(node('strong', '', 'Your workspace'), node('span', 'le-hint', 'Drag panel headers to move · drag bottom edges or corners to resize'));
            const reset = node('button', 'le-btn', 'Reset layout');
            reset.type = 'button';
            reset.title = 'Restore panel positions and sizes. Your image layout is kept.';
            reset.addEventListener('click', () => this.reset());
            intro.appendChild(reset);
            header.appendChild(intro);
            // Keep the primary action at the top right, independent of panel positions.
            if (editor.host.canGenerate) {
                const actions = node('div', 'le-generation-actions');
                actions.append(editor.genStatusText, editor.genProgress.parentElement,
                    editor.keepSeedBox.parentElement, editor.generateButton, editor.cancelButton);
                header.appendChild(actions);
                parts.results.querySelector('.le-results-head').remove();
                editor.renderResults();
            }
            this.grid = node('div', 'le-workspace');
            this.grid.setAttribute('aria-label', 'Customizable editor panels');
            editor.root.append(header, this.grid);
            for (const [id, title] of [['tools', 'Tools'], ['layers', 'Layers'], ['canvas', 'Canvas'],
                ['inspector', 'Inspector'], ['scene', 'Scene caption'], ['checks', 'Checks'],
                ['results', 'Results'], ['json', 'Prompt JSON']]) {
                if (parts[id]) this.addPanel(id, title, parts[id]);
            }
            editor.sceneCaption.setAttribute('aria-label', 'Scene caption');
            editor.sceneCaption.style.height = this.state.captionHeight + 'px';
            // A native textarea resize grows its row below the canvas. Save that preference too.
            this.captionObserver = new ResizeObserver(() => {
                if (!editor.sceneCaption.getClientRects().length) return;
                const height = Math.round(editor.sceneCaption.getBoundingClientRect().height);
                if (height < 72 || height === this.state.captionHeight) return;
                this.state.captionHeight = height;
                clearTimeout(this.saveTimer);
                this.saveTimer = setTimeout(() => this.save(), 150);
            });
            this.captionObserver.observe(editor.sceneCaption);
        }

        save() {
            try { localStorage.setItem(STORAGE, JSON.stringify(this.state)); } catch (_) { /* private browsing */ }
        }

        dimensions(id) {
            return this.state.panels[id] || DEFAULTS[id];
        }

        addPanel(id, title, content) {
            if (!content || this.panels.has(id) || !Object.hasOwn(DEFAULTS, id)) return;
            const panel = node('section', 'le-workspace-panel' + (DEFAULTS[id].bounded ? ' le-bounded-panel' : ''));
            panel.dataset.panel = id;
            panel.setAttribute('aria-label', title + ' panel');
            const header = node('div', 'le-panel-header');
            header.draggable = true;
            header.title = 'Drag to move ' + title + '. Focus the grip and use ↑ / ↓ to reorder.';
            const grip = node('button', 'le-panel-move', '⠿');
            grip.type = 'button';
            grip.setAttribute('aria-label', 'Move ' + title + ' panel');
            grip.addEventListener('keydown', event => {
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const order = this.state.order;
                const current = order.indexOf(id);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 :
                    clamp(current + (event.key === 'ArrowUp' ? -1 : 1), 0, order.length - 1);
                order.splice(current, 1); order.splice(next, 0, id);
                this.arrange(); this.save(); grip.focus();
            });
            header.append(grip, node('strong', '', title), node('span', 'le-panel-move-hint', 'drag to move'));
            const body = node('div', 'le-panel-body');
            body.appendChild(content);
            const footer = node('div', 'le-panel-sizebar');
            const vertical = node('div', 'le-panel-height-handle', id === 'canvas' ? '↕ Drag to resize canvas area' : '⋯');
            vertical.tabIndex = 0;
            vertical.setAttribute('role', 'separator');
            vertical.setAttribute('aria-orientation', 'horizontal');
            vertical.setAttribute('aria-label', 'Resize ' + title + ' height');
            vertical.title = 'Drag up or down to resize ' + title + '. Arrow keys adjust height.';
            const corner = node('button', 'le-panel-resize-corner', '↘');
            corner.type = 'button';
            corner.setAttribute('aria-label', 'Resize ' + title + ' width and height');
            corner.title = 'Drag to resize width and height. Arrow keys also resize; Home restores size.';
            footer.append(vertical, corner);
            panel.append(header, body, footer);
            this.panels.set(id, panel);
            for (const [handle, horizontal] of [[vertical, false], [corner, true]]) {
                handle.addEventListener('pointerdown', event => this.startResize(event, id, horizontal));
                handle.addEventListener('keydown', event => {
                    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
                    event.preventDefault(); event.stopPropagation();
                    const current = this.dimensions(id);
                    let span = current.span, height = current.height;
                    if (event.key === 'Home') { span = DEFAULTS[id].span; height = DEFAULTS[id].height; }
                    else if (horizontal && ['ArrowLeft', 'ArrowRight'].includes(event.key)) span += event.key === 'ArrowLeft' ? -1 : 1;
                    else if (['ArrowUp', 'ArrowDown'].includes(event.key)) height += event.key === 'ArrowUp' ? -32 : 32;
                    else return;
                    this.resize(id, span, height);
                    this.save();
                });
            }
            header.addEventListener('dragstart', event => {
                this.dragged = id;
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-moss-workspace-panel', id);
                event.dataTransfer.setData('text/plain', title);
                panel.classList.add('le-panel-dragging');
            });
            header.addEventListener('dragend', () => this.clearDrag());
            panel.addEventListener('dragover', event => {
                if (!this.dragged || this.dragged === id) return;
                event.preventDefault(); event.stopPropagation();
                const before = event.clientY < panel.getBoundingClientRect().top + panel.clientHeight / 2;
                panel.dataset.drop = before ? 'before' : 'after';
                event.dataTransfer.dropEffect = 'move';
            });
            panel.addEventListener('dragleave', event => {
                if (!panel.contains(event.relatedTarget)) delete panel.dataset.drop;
            });
            panel.addEventListener('drop', event => {
                if (!this.dragged || this.dragged === id) return;
                event.preventDefault(); event.stopPropagation();
                const order = this.state.order.filter(value => value !== this.dragged);
                order.splice(order.indexOf(id) + (panel.dataset.drop === 'after' ? 1 : 0), 0, this.dragged);
                this.state.order = order;
                this.clearDrag(); this.arrange(); this.save();
            });
            this.applySize(id);
            this.arrange();
        }

        clearDrag() {
            this.dragged = null;
            for (const panel of this.panels.values()) {
                delete panel.dataset.drop;
                panel.classList.remove('le-panel-dragging');
            }
        }

        arrange() {
            for (const id of this.state.order) {
                const panel = this.panels.get(id);
                if (panel) this.grid.appendChild(panel);
            }
        }

        applySize(id) {
            const panel = this.panels.get(id), size = this.dimensions(id);
            panel.style.setProperty('--le-panel-span', size.span);
            panel.style.setProperty('--le-panel-height', size.height + 'px');
            const handle = panel.querySelector('.le-panel-height-handle');
            handle.setAttribute('aria-valuenow', Math.round(size.height));
            handle.setAttribute('aria-valuemin', DEFAULTS[id].minHeight);
            handle.setAttribute('aria-valuemax', 4000);
        }

        resize(id, span, height) {
            const previous = this.dimensions(id);
            const next = { span: clamp(Math.round(span), DEFAULTS[id].minSpan, 12), height: clamp(height, DEFAULTS[id].minHeight, 4000) };
            if (id === 'scene') {
                const caption = this.editor.sceneCaption;
                const newHeight = clamp(caption.getBoundingClientRect().height + next.height - previous.height, 72, 3500);
                caption.style.height = newHeight + 'px';
                this.state.captionHeight = newHeight;
            }
            this.state.panels[id] = next;
            this.applySize(id);
        }

        startResize(event, id, horizontal) {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            const handle = event.currentTarget;
            const start = { x: event.clientX, y: event.clientY, ...this.dimensions(id) };
            const gap = parseFloat(getComputedStyle(this.grid).columnGap) || 0;
            const column = (this.grid.clientWidth + gap) / 12;
            this.editor.root.classList.add('le-workspace-resizing');
            handle.setPointerCapture(event.pointerId);
            const move = e => {
                if (e.pointerId !== event.pointerId) return;
                this.resize(id, start.span + (horizontal ? (e.clientX - start.x) / column : 0), start.height + e.clientY - start.y);
            };
            const end = e => {
                if (e.pointerId !== event.pointerId) return;
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', end);
                handle.removeEventListener('pointercancel', end);
                if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
                this.editor.root.classList.remove('le-workspace-resizing');
                this.save();
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', end);
            handle.addEventListener('pointercancel', end);
        }

        reset() {
            clearTimeout(this.saveTimer);
            this.state = { order: Object.keys(DEFAULTS), panels: {}, captionHeight: 80 };
            this.editor.sceneCaption.style.height = '80px';
            for (const id of this.panels.keys()) this.applySize(id);
            this.arrange(); this.save();
            this.editor.toast('Panel layout reset. Your image layout is kept.');
        }
    }
    LE.Workspace = Workspace;
})();
