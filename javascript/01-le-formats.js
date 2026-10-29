// Layout Editor - format profiles.
// A profile decides which element types and fields the editor shows, adds its own validation,
// and converts the canonical model to and from the prompt string a model reads.
(function () {
    'use strict';
    const LE = window.LayoutEditor = window.LayoutEditor || {};

    LE.formats = {};
    LE.formatOrder = [];

    LE.registerFormat = function (profile) {
        LE.formats[profile.id] = profile;
        if (!LE.formatOrder.includes(profile.id)) {
            LE.formatOrder.push(profile.id);
        }
    };

    LE.getFormat = function (id) {
        return LE.formats[id] || LE.formats[LE.formatOrder[0]];
    };

    /** Extracts the outermost JSON object from a prompt that may have text around it. */
    LE.extractJsonObject = function (str) {
        if (typeof str !== 'string') {
            return null;
        }
        const start = str.indexOf('{');
        const end = str.lastIndexOf('}');
        if (start === -1 || end <= start) {
            return null;
        }
        try {
            return JSON.parse(str.substring(start, end + 1));
        }
        catch (e) {
            return null;
        }
    };

    // ------------------------------------------------------------------ MOSS-Image
    // Spec: https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md (Layout Prompts)
    // bbox = [y_min, x_min, y_max, x_max], absolute pixels, origin at the canvas center.

    const MOSS_TYPES = [
        { id: 'text', label: 'Text', key: 't' },
        { id: 'object', label: 'Object', key: 'o' },
        { id: 'character', label: 'Character', key: 'c', optional: true }
    ];

    const moss = {
        id: 'moss',
        name: 'MOSS-Image',
        description: 'OpenMOSS MOSS-Image layout JSON (centered pixel coordinates, yxyx).',
        sceneLabel: 'Scene caption',
        scenePlaceholder: 'Describe the whole image: subject, setting, style, medium, lighting and colors.',
        metaSuggestions: ['poster', 'photo', 'illustration', 'infographic', 'comic', 'anime', '3d render', 'product shot'],
        hasCanvasField: true,
        compatClasses: ['moss-image'],

        types(model) {
            return MOSS_TYPES.filter(t => !t.optional || model.options.characterType);
        },

        itemFields(type) {
            return type === 'text' ? ['caption', 'text'] : ['caption'];
        },

        placeholder(type) {
            if (type === 'text') {
                return 'How the text looks: e.g. "Bold white sans-serif title with a soft drop shadow".';
            }
            if (type === 'character') {
                return 'Who it is and what they do: e.g. "A young woman in a yellow raincoat, laughing, holding an umbrella".';
            }
            return 'What it is: e.g. "A red steel road bicycle clamped in a grey repair stand".';
        },

        textPlaceholder: 'The exact words to render. Press Enter for a line break.',

        typeForExport(model, item) {
            if (item.type === 'character' && !model.options.characterType) {
                return 'object';
            }
            return item.type;
        },

        validate(model) {
            const issues = [];
            if (!model.scene.caption.trim()) {
                issues.push({ level: 'error', message: 'The scene caption is empty. MOSS-Image reads it as the description of the whole image.' });
            }
            return issues;
        },

        exportObject(model) {
            const halfW = model.width / 2;
            const halfH = model.height / 2;
            const summary = {};
            if (model.scene.meta.length) {
                summary.meta = model.scene.meta.slice();
            }
            summary.canvas = model.scene.canvas || 'single';
            summary.caption = model.scene.caption.trim();
            if (model.scene.palette) summary.palette = model.scene.palette.slice();
            const items = [];
            for (const item of model.items) {
                if (!item.visible) {
                    continue;
                }
                const pixel = v => Number(v.toFixed(9));
                const p = {
                    x1: Math.floor(pixel(item.x * model.width)),
                    y1: Math.floor(pixel(item.y * model.height)),
                    x2: Math.ceil(pixel((item.x + item.w) * model.width)),
                    y2: Math.ceil(pixel((item.y + item.h) * model.height))
                };
                const label = this.typeForExport(model, item);
                const out = { label: label, caption: (item.caption || '').trim() };
                for (const key of ['tags', 'palette']) {
                    if (item[key]) out[key] = item[key].slice();
                }
                if (label === 'text' || item.text) {
                    out.text = item.text || '';
                }
                out.bbox = [
                    Math.round(p.y1 - halfH),
                    Math.round(p.x1 - halfW),
                    Math.round(p.y2 - halfH),
                    Math.round(p.x2 - halfW)
                ];
                items.push(out);
            }
            return {
                summary: summary,
                items: items,
                bbox_coord_space: 'abs_centralized',
                bbox_format: 'yxyx'
            };
        },

        exportPrompt(model) {
            const obj = this.exportObject(model);
            return model.options.compactJson ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
        },

        /** True when the string looks like a MOSS layout prompt. */
        detect(str) {
            const obj = LE.extractJsonObject(str);
            return !!(obj && Array.isArray(obj.items) && (obj.summary || obj.bbox_format || obj.bbox_coord_space));
        },

        /**
         * Parses a MOSS layout prompt into the given model (the model supplies width/height, since the JSON has none).
         * Returns { model, notes } or throws an Error with a readable message.
         */
        importPrompt(str, baseModel) {
            const obj = LE.extractJsonObject(str);
            if (!obj) {
                throw new Error('No JSON object found.');
            }
            if (!Array.isArray(obj.items)) {
                throw new Error('This JSON has no "items" list, so it is not a MOSS layout.');
            }
            LE.checkImport(obj);
            const notes = [];
            const model = LE.cloneModel(baseModel);
            model.formatId = 'moss';
            if (obj.width !== undefined) model.width = obj.width;
            if (obj.height !== undefined) model.height = obj.height;
            const summary = obj.summary || {};
            delete model.scene.palette;
            if (summary.palette) model.scene.palette = summary.palette.slice();
            model.scene.caption = typeof summary.caption === 'string' ? summary.caption : '';
            model.scene.meta = Array.isArray(summary.meta) ? summary.meta.map(String) : [];
            model.scene.canvas = typeof summary.canvas === 'string' ? summary.canvas : 'single';
            const format = (obj.bbox_format || 'yxyx').toLowerCase();
            const space = (obj.bbox_coord_space || 'abs_centralized').toLowerCase();
            if (format !== 'yxyx' && format !== 'xyxy') {
                throw new Error(`Unsupported bbox_format "${obj.bbox_format}".`);
            }
            if (space !== 'abs_centralized' && space !== 'abs') {
                throw new Error(`Unsupported bbox_coord_space "${obj.bbox_coord_space}".`);
            }
            const W = model.width, H = model.height;
            let outside = false;
            model.items = [];
            for (const raw of obj.items) {
                if (!raw || !Array.isArray(raw.bbox) || raw.bbox.length !== 4) {
                    notes.push('Skipped an item without a valid 4-number bbox.');
                    continue;
                }
                let [a, b, c, d] = raw.bbox.map(Number);
                let x1, y1, x2, y2;
                if (format === 'yxyx') {
                    y1 = a; x1 = b; y2 = c; x2 = d;
                }
                else {
                    x1 = a; y1 = b; x2 = c; y2 = d;
                }
                if (space === 'abs_centralized') {
                    x1 += W / 2; x2 += W / 2; y1 += H / 2; y2 += H / 2;
                }
                if (x1 < -1 || y1 < -1 || x2 > W + 1 || y2 > H + 1) {
                    outside = true;
                }
                let label = String(raw.label || 'object').toLowerCase();
                if (label === 'obj') {
                    label = 'object';
                }
                if (!['text', 'object', 'character'].includes(label)) {
                    notes.push(`Unknown label "${raw.label}" imported as Object.`);
                    label = 'object';
                }
                if (label === 'character') {
                    model.options.characterType = true;
                }
                const item = LE.newItem(label, 0, 0, 0, 0);
                item.caption = typeof raw.caption === 'string' ? raw.caption : '';
                item.text = typeof raw.text === 'string' ? raw.text : '';
                for (const key of ['tags', 'palette']) {
                    if (raw[key]) item[key] = raw[key].slice();
                }
                LE.setItemPixels(model, item, x1, y1, x2 - x1, y2 - y1);
                model.items.push(item);
            }
            if (outside) {
                notes.push(`Some boxes fall outside ${W}×${H}. The layout was probably made for another resolution: set the canvas size it was made for.`);
            }
            return { model: model, notes: notes };
        }
    };

    // Reject unsupported fields and malformed geometry before changing the editor.
    LE.checkImport = function (obj) {
        const require = (ok, message) => { if (!ok) throw new Error(message); };
        const fields = (value, allowed, location) => {
            require(value && typeof value === 'object' && !Array.isArray(value), location + ' must be an object.');
            for (const key of Object.keys(value)) require(allowed.includes(key), `${location}: unsupported field "${key}".`);
        };
        const text = (value, location) => require(typeof value === 'string' && value.trim(), location + ' must be nonempty text.');
        const strings = (value, location) => {
            require(Array.isArray(value), location + ' must be an array.');
            value.forEach(v => text(v, location));
        };
        fields(obj, ['width', 'height', 'summary', 'items', 'bbox_coord_space', 'bbox_format'], 'Layout');
        for (const key of ['width', 'height']) {
            if (obj[key] !== undefined) require(Number.isInteger(obj[key]) && obj[key] > 0 && obj[key] % 16 === 0, key + ' must be a positive integer multiple of 16.');
        }
        require((obj.width === undefined) === (obj.height === undefined), 'Supply both width and height.');
        fields(obj.summary, ['caption', 'meta', 'canvas', 'palette'], 'summary');
        text(obj.summary.caption, 'summary.caption');
        if (obj.summary.canvas !== undefined) require(['single', 'multi_panel', 'collage'].includes(obj.summary.canvas), 'Unknown summary.canvas.');
        for (const key of ['meta', 'palette']) if (obj.summary[key] !== undefined) strings(obj.summary[key], 'summary.' + key);
        require(Array.isArray(obj.items) && obj.items.length, 'items must be a nonempty flat array.');
        for (const [i, item] of obj.items.entries()) {
            const loc = `items[${i}]`;
            fields(item, ['label', 'caption', 'text', 'bbox', 'tags', 'palette'], loc);
            require(['object', 'character', 'text'].includes(item.label), loc + ': unknown label.');
            text(item.caption, loc + '.caption');
            if (item.label === 'text' || item.text !== undefined) text(item.text, loc + '.text');
            for (const key of ['tags', 'palette']) if (item[key] !== undefined) strings(item[key], loc + '.' + key);
            require(Array.isArray(item.bbox) && item.bbox.length === 4 && item.bbox.every(Number.isFinite), loc + ': bbox must contain four finite numbers.');
            require(item.bbox[0] < item.bbox[2] && item.bbox[1] < item.bbox[3], loc + ': bbox must have positive area.');
        }
    };

    LE.registerFormat(moss);
})();

// Interchange draft: absolute xyxy pixels with its own canvas dimensions.
window.LayoutEditor.toDraft = function (model) {
    const LE = window.LayoutEditor;
    const obj = LE.getFormat(model.formatId).exportObject(model);
    obj.width = model.width;
    obj.height = model.height;
    obj.bbox_coord_space = 'abs';
    obj.bbox_format = 'xyxy';
    const visible = model.items.filter(item => item.visible);
    obj.items.forEach((item, index) => {
        const source = visible[index];
        item.bbox = [source.x * model.width, source.y * model.height,
            (source.x + source.w) * model.width, (source.y + source.h) * model.height]
            .map(value => Number(value.toFixed(9)));
    });
    return obj;
};
