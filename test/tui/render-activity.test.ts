import { describe, expect, test } from "bun:test";
import { Renderer } from "../../src/tui/render.ts";

function fakeStream() {
  let buf = "";
  const stream = {
    isTTY: false,
    columns: 80,
    write(s: string) {
      buf += s;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, output: () => buf };
}

describe("Renderer onActivity", () => {
  test("wait() routes to the callback instead of the spinner", () => {
    const { stream, output } = fakeStream();
    const labels: (string | null)[] = [];
    const renderer = new Renderer(stream, { onActivity: (l) => labels.push(l) });
    renderer.wait();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toBeTruthy();
    // Nothing painted: the footer owns the indicator now.
    expect(output()).toBe("");
    renderer.close();
  });

  test("tool_start reports the running tool; deltas clear the label", () => {
    const { stream } = fakeStream();
    const labels: (string | null)[] = [];
    const renderer = new Renderer(stream, { onActivity: (l) => labels.push(l) });
    renderer.handle({ type: "tool_start", id: "1", name: "bash", summary: "ls" });
    expect(labels.at(-1)).toBe("running bash");
    renderer.handle({ type: "text_delta", text: "hi" });
    expect(labels.at(-1)).toBeNull();
    renderer.close();
  });
});
