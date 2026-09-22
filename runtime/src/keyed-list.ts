// Preserve live rows and their positions across unordered snapshots and text updates.
export class KeyedList<Item extends { id: string }, View> {
  private rows = new Map<string, { item: Item; view: View }>();

  constructor(private readonly host: {
    create(item: Item): View;
    append(view: View): void;
    update(view: View, item: Item, index: number): void;
    remove(view: View): void;
  }) {}

  render(items: readonly Item[]): Item[] {
    const incoming = new Map(items.map(item => [item.id, item]));
    for (const [id, row] of this.rows) {
      if (!incoming.has(id)) { this.host.remove(row.view); this.rows.delete(id); }
    }
    for (const [id, item] of incoming) {
      const row = this.rows.get(id);
      if (row) row.item = item;
      else {
        const view = this.host.create(item);
        this.rows.set(id, { item, view });
        this.host.append(view);
      }
    }
    const ordered: Item[] = [];
    for (const { item, view } of this.rows.values()) {
      this.host.update(view, item, ordered.length);
      ordered.push(item);
    }
    return ordered;
  }
}
