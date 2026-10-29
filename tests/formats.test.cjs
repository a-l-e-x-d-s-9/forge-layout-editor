const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({ window: {} });
for (const name of ['00-le-model.js', '01-le-formats.js', '02-le-validate.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../javascript', name), 'utf8'), context);
}
const LE = context.window.LayoutEditor;
const plain = x => JSON.parse(JSON.stringify(x));
const moss = LE.getFormat('moss');
const draft = {
    width: 1536, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
    summary: { caption: 'A warm ceramic cup campaign.', palette: ['ivory', 'green'], meta: ['photo'], canvas: 'single' },
    items: [
        { label: 'object', caption: 'An ivory ceramic cup.', bbox: [176,224,800,864], tags: ['ceramic'], palette: ['ivory'] },
        { label: 'text', caption: 'Dark green Chinese title.', text: '把日常，过成诗。\nA (warm) cup', bbox: [928,272,1408,448] }
    ]
};
function load(obj = draft) { return moss.importPrompt(JSON.stringify(obj), LE.newModel()).model; }
test('official example honors draft dimensions and compiles centered yxyx', () => {
    const model = load();
    assert.equal(model.width, 1536);
    assert.equal(model.height, 1024);
    const obj = plain(moss.exportObject(model));
    assert.deepEqual(obj.items[0].bbox, [-288,-592,352,32]);
    assert.equal(obj.bbox_coord_space, 'abs_centralized');
    assert.equal(obj.bbox_format, 'yxyx');
    assert.equal(obj.width, undefined);
    assert.deepEqual(obj.summary.palette, draft.summary.palette);
    assert.deepEqual(obj.items[0].tags, ['ceramic']);
    assert.deepEqual(obj.items[0].palette, ['ivory']);
    assert.equal(obj.items[1].text, draft.items[1].text);
    assert.equal(LE.validate(model).filter(x => x.level === 'error').length, 0);
});
test('fractional edges are enclosed as in the MOSS compiler', () => {
    const input = structuredClone(draft);
    input.items[0].bbox = [176.2,224.8,800.1,864.01];
    assert.deepEqual(plain(moss.exportObject(load(input))).items[0].bbox, [-288,-592,353,33]);
    assert.deepEqual(plain(LE.toDraft(load(input))).items[0].bbox, input.items[0].bbox);
});
test('integer edges survive floating point normalization', () => {
    const input = structuredClone(draft);
    input.width = 1008;
    input.items = [{ label: 'object', caption: 'Cup', bbox: [3,17,998,999] }];
    assert.deepEqual(plain(LE.toDraft(load(input))).items[0].bbox, input.items[0].bbox);
});
test('compiled prompt uses supplied canvas and round trips optional metadata', () => {
    const first = load();
    const result = moss.importPrompt(moss.exportPrompt(first), first).model;
    assert.deepEqual(plain(moss.exportObject(result)), plain(moss.exportObject(first)));
    assert.deepEqual(plain(LE.toDraft(result)).items, draft.items);
});
test('character is supported by default and hidden boxes are omitted', () => {
    const model = load();
    model.items[0].type = 'character';
    assert.equal(moss.exportObject(model).items[0].label, 'character');
    model.items[0].visible = false;
    assert.equal(moss.exportObject(model).items.length, 1);
});
test('resolution changes keep relative positions and recompute centered coordinates', () => {
    const model = load();
    model.width = 768; model.height = 512;
    assert.deepEqual(plain(moss.exportObject(model)).items[0].bbox, [-144,-296,176,16]);
});
test('bad imports fail atomically instead of losing content', () => {
    for (const mutate of [
        d => d.items[0].bbox = [8, 0, 2, 3],
        d => d.items[0].bbox = ['1', 0, 2, 3],
        d => d.items[0].children = [],
        d => d.summary.unrecognized = 'discard me',
        d => d.items[1].text = '',
        d => d.width = 1001,
        d => d.items[0].palette = 'green',
        d => d.items = [],
        d => d.bbox_coord_space = 'normalized'
    ]) {
        const input = structuredClone(draft); mutate(input);
        const base = load(); const snapshot = JSON.stringify(base);
        assert.throws(() => moss.importPrompt(JSON.stringify(input), base));
        assert.equal(JSON.stringify(base), snapshot);
    }
});
test('generation validation detects out of bounds including subpixel edges', () => {
    const model = load();
    model.items[0].x = -0.0001;
    assert.ok(LE.validate(model).some(x => x.level === 'error' && x.message.includes('outside')));
    model.items[0].x = NaN;
    assert.ok(LE.validate(model).some(x => x.level === 'error' && x.message.includes('invalid coordinates')));
});
test('blank scene and empty captions block generation', () => {
    const model = load(); model.scene.caption = ''; model.items[0].caption = '';
    assert.equal(LE.validate(model).filter(x => x.level === 'error').length, 2);
});
