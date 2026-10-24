import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { createRenderer, h, nextTick, reactive } from "vue";

// Compile the actual SFCs without adding a browser or test-runner dependency.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".vue")) return nextLoad(url, context);
    const { descriptor } = parse(readFileSync(fileURLToPath(url), "utf8"));
    const script = compileScript(descriptor, { id: url, inlineTemplate: true });
    const { outputText } = ts.transpileModule(script.content, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

globalThis.location = { href: "https://example.test/articles/1" };
globalThis.window = { matchMedia: () => ({ matches: false }) };
let frameId = 0;
const frames = new Map();
globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);

const { default: MarkdownInline } = await import("./MarkdownInline.vue");
const { default: AnswerInline } = await import("./AnswerInline.vue");
const { default: MarkdownBlocks } = await import("./MarkdownBlocks.vue");
const { default: AnswerMarkdown } = await import("./AnswerMarkdown.vue");
const { parseMarkdown } = await import("../markdown.ts");

const node = (type, text = "") => ({ type, text, props: {}, children: [], parent: null });
const renderer = createRenderer({
  createElement: node,
  createText: (text) => node("#text", text),
  createComment: (text) => node("#comment", text),
  setText: (element, text) => { element.text = text; },
  setElementText(element, text) { element.children = []; element.text = text; },
  patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  insert(element, parent, anchor = null) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, element);
    element.parent = parent;
  },
  remove(element) {
    const parent = element.parent;
    if (parent) parent.children.splice(parent.children.indexOf(element), 1);
    element.parent = null;
  },
  parentNode: (element) => element.parent,
  nextSibling: (element) => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
});

function mount(t, component, props, slots) {
  const root = node("root");
  const app = renderer.createApp({ render: () => h(component, props, slots) });
  app.mount(root);
  t.after(() => app.unmount());
  return root;
}
const all = (root, type) => [
  ...(root.type === type ? [root] : []),
  ...root.children.flatMap((child) => all(child, type)),
];
const text = (root) => root.type === "#comment" ? "" : root.text + root.children.map(text).join("");
const elements = (root) => root.children.filter((child) => !child.type.startsWith("#"));

test("shared inline rendering keeps safe links, formatting and literal HTML", (t) => {
  const source = '**bold** `code` [safe](/docs) [mail](mailto:a@example.test) [bad](javascript:alert) <img src=x> [1]';
  for (const component of [MarkdownInline, AnswerInline]) {
    const root = mount(t, component, { text: source, ...(component === AnswerInline ? { sourceCount: 0 } : {}) });
    assert.equal(text(all(root, "strong")[0]), "bold");
    assert.equal(text(all(root, "code")[0]), "code");
    assert.deepEqual(all(root, "a").map((link) => link.props.href), ["https://example.test/docs", "mailto:a@example.test"]);
    for (const link of all(root, "a")) {
      assert.equal(link.props.target, "_blank");
      assert.equal(link.props.rel, "noopener noreferrer");
    }
    assert.equal(all(root, "img").length, 0);
    assert.equal(all(root, "button").length, 0);
    assert.ok(text(root).includes("[bad](javascript:alert) <img src=x> [1]"));
    assert.equal(all(root, "strong")[0].props.class, component === AnswerInline ? "font-semibold text-[#29342e]" : "");
  }
});

test("answer citations retain bounds, active state and forwarded events", async (t) => {
  const cited = [];
  const props = reactive({ text: "[0] [1] [2] [3] ` [1] ` **[1]** [1](/source)", sourceCount: 2, activeCitation: 2, onCite: (value) => cited.push(value) });
  const root = mount(t, AnswerInline, props);
  assert.deepEqual(all(root, "button").map(text), ["1", "2"]);
  const button = all(root, "button")[1];
  assert.equal(button.props.class, "citation citation-active");
  assert.equal(button.props["aria-label"], "查看引用来源 2");
  button.props.onClick();
  assert.deepEqual(cited, [2]);
  assert.ok(text(root).includes("[0] 1 2 [3]"));
  props.sourceCount = 1;
  props.activeCitation = 1;
  await nextTick();
  assert.equal(all(root, "button").length, 1);
  assert.equal(all(root, "button")[0].props.class, "citation citation-active");
  assert.ok(text(root).includes("[2] [3]"));
});

const markdown = '# Heading [1]\n\nParagraph **bold** [1]\n\n3. item [1]\n4. next\n\n- bullet [1]\n\n```txt\n**literal** [1] <b>\n```\n\n| **header** [1] | link |\n| --- | --- |\n| `cell` [1] | [safe](/table) |';

test("shared blocks preserve article structure, classes and plain-text tables", (t) => {
  const root = mount(t, MarkdownBlocks, { blocks: parseMarkdown(markdown) });
  assert.deepEqual(elements(root).map((child) => child.type), ["h1", "p", "ol", "ul", "pre", "div"]);
  assert.equal(all(root, "h1")[0].props.class, "markdown-heading");
  assert.equal(all(root, "p")[0].props.class, "markdown-paragraph");
  assert.equal(all(root, "ol")[0].props.start, 3);
  assert.equal(all(root, "ol")[0].props.class, "markdown-list list-decimal");
  assert.equal(all(root, "ul")[0].props.class, "markdown-list list-disc");
  assert.equal(text(all(root, "pre")[0]), "**literal** [1] <b>");
  assert.equal(all(root, "pre")[0].props.class, "markdown-code");
  const table = all(root, "table")[0];
  assert.equal(table.parent.props.class, "markdown-table-wrap");
  assert.equal(text(all(table, "th")[0]), "**header** [1]");
  assert.equal(text(all(table, "td")[0]), "`cell` [1]");
  assert.equal(all(table, "strong").length + all(table, "code").length + all(table, "a").length, 0);
  assert.equal(all(root, "button").length, 0);
});

test("answer blocks keep direct-child styling, inline tables and citation forwarding", (t) => {
  const cited = [];
  const root = mount(t, AnswerMarkdown, { text: markdown, sourceCount: 1, activeCitation: 1, onCite: (value) => cited.push(value) });
  const wrapper = elements(root)[0];
  assert.deepEqual(elements(wrapper).map((child) => child.type), ["h1", "p", "ol", "ul", "pre", "div"]);
  assert.ok(all(root, "h1")[0].props.class.includes("text-[15px]"));
  assert.equal(all(root, "ol")[0].props.start, 3);
  assert.equal(all(root, "li")[0].props.class, "pl-1");
  const table = all(root, "table")[0];
  assert.equal(table.props.class, "w-full border-collapse text-xs");
  assert.equal(text(all(table, "strong")[0]), "header");
  assert.equal(text(all(table, "code")[0]), "cell");
  assert.equal(all(table, "a")[0].props.href, "https://example.test/table");
  assert.equal(all(root, "button").length, 6);
  for (const button of all(root, "button")) button.props.onClick();
  assert.deepEqual(cited, [1, 1, 1, 1, 1, 1]);
  assert.equal(text(all(root, "pre")[0]), "**literal** [1] <b>");
});

test("streaming still releases text per frame, flushes on completion and cancels on unmount", async (t) => {
  const props = reactive({ text: "A long streamed answer with enough characters to release gradually.", sourceCount: 0, streaming: true });
  const root = mount(t, AnswerMarkdown, props);
  t.after(() => assert.equal(frames.size, 0));
  const wrapper = elements(root)[0];
  assert.ok(wrapper.props.class.includes("answer-streaming"));
  assert.equal(text(root), "");
  const [id, tick] = frames.entries().next().value;
  frames.delete(id);
  tick(16);
  await nextTick();
  assert.ok(text(root).length > 0 && text(root).length < props.text.length);
  assert.equal(elements(wrapper)[0].type, "p");
  props.streaming = false;
  await nextTick();
  assert.equal(text(root), props.text);
  assert.ok(!wrapper.props.class.includes("answer-streaming"));
  assert.equal(frames.size, 0);
  props.text += " More streamed text.";
  props.streaming = true;
  await nextTick();
  assert.equal(frames.size, 1);
});
