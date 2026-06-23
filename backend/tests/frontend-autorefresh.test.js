import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName;
        this.style = {};
        this.children = [];
        this._idMap = new Map();
        this._innerHTML = '';
        this.textContent = '';
        this.id = '';
    }

    set innerHTML(value) {
        this._innerHTML = value;
        this._idMap.clear();
        const regex = /id="([^"]+)"/g;
        let match;
        while ((match = regex.exec(value)) !== null) {
            const el = new FakeElement('div');
            el.id = match[1];
            this._idMap.set(match[1], el);
        }
    }

    get innerHTML() {
        return this._innerHTML;
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    querySelector(selector) {
        if (selector.startsWith('#')) {
            return this._idMap.get(selector.slice(1)) || null;
        }
        return null;
    }

    setAttribute() { }
}

test('frontend auto-refresh is triggered after realtime complete event', async () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const elements = new Map();
    const body = new FakeElement('body');
    const reportType = new FakeElement('select');
    reportType.value = 'raw';
    elements.set('report-type-select', reportType);

    global.localStorage = {
        getItem: () => null,
        setItem: () => { },
        removeItem: () => { }
    };

    global.document = {
        body,
        getElementById: (id) => elements.get(id) || null,
        querySelector: () => null,
        createElement: (tag) => {
            const el = new FakeElement(tag);
            Object.defineProperty(el, 'id', {
                get() { return this._id || ''; },
                set(v) {
                    this._id = v;
                    if (v) elements.set(v, this);
                }
            });
            return el;
        }
    };

    global.window = {
        location: { origin: 'http://localhost', protocol: 'http:', host: 'localhost' },
        addEventListener: () => { },
        dispatchEvent: () => { }
    };
    global.CustomEvent = class {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };

    const appModulePath = pathToFileURL(path.resolve(__dirname, '..', '..', 'frontend', 'public', 'js', 'app.js')).href + `?t=${Date.now()}`;
    await import(appModulePath);

    const app = global.window.app;
    assert.ok(app);

    let receivedListener = null;
    let refreshCount = 0;
    app.generateReport = () => { refreshCount += 1; };
    app.wsClient = {
        addListener: (cb) => { receivedListener = cb; },
        connect: () => { }
    };

    app.setupRealtimeSync();
    assert.ok(typeof receivedListener === 'function');

    receivedListener({ type: 'complete', databases_count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.equal(refreshCount, 1);
});
