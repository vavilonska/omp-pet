import { expect, test } from "bun:test";
import { KeyedList } from "../src/keyed-list";

test("reordered snapshots and streaming updates preserve nodes and positions", () => {
  type Item = { id: string; title: string };
  const nodes: { title: string; index: number }[] = [];
  let created = 0;
  const list = new KeyedList<Item, typeof nodes[number]>({
    create: item => { created++; return { title: item.title, index: -1 }; },
    append: node => { nodes.push(node); },
    remove: node => { nodes.splice(nodes.indexOf(node), 1); },
    update: (node, item, index) => { node.title = item.title; node.index = index; },
  });
  const a = { id: "a", title: "A" }, b = { id: "b", title: "B" };
  list.render([a, b]);
  const original = [...nodes];
  for (let i = 0; i < 100; i++) {
    expect(list.render([{ ...b, title: `B ${i}` }, a]).map(item => item.id)).toEqual(["a", "b"]);
    expect(nodes[0]).toBe(original[0]);
    expect(nodes[1]).toBe(original[1]);
  }
  expect(created).toBe(2);
  expect(nodes[1]?.title).toBe("B 99");
  list.render([b, { id: "c", title: "C" }]);
  expect(nodes[0]).toBe(original[1]);
  expect(nodes.map(node => node.index)).toEqual([0, 1]);
  expect(created).toBe(3);
  list.render([]);
  expect(nodes).toEqual([]);
});
