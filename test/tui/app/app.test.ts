import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "../../../src/tui/app/app.tsx";
import { createFooterStore } from "../../../src/tui/app/store.ts";

const STATUS = {
  provider: "test",
  model: "test-model",
  contextUsed: 0,
  contextWindow: 1,
  mode: "ask",
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
};

describe("split-footer positioning", () => {
  test("starting a turn keeps the footer pinned below the transcript", async () => {
    const store = createFooterStore(STATUS, {
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    const setup = await testRender(() => App({ store }), {
      width: 80,
      height: 24,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
      autoFocus: false,
    });
    const renderer = setup.renderer as unknown as {
      rendererPtr: unknown;
      lib: {
        setRenderOffset: (ptr: unknown, offset: number) => void;
      };
    };
    const originalSetRenderOffset = renderer.lib.setRenderOffset;
    let offsetWrites = 0;

    try {
      await setup.flush();
      renderer.lib.setRenderOffset = (ptr, offset) => {
        offsetWrites += 1;
        originalSetRenderOffset.call(renderer.lib, ptr, offset);
      };

      store.setBusy({ since: Date.now(), label: "starting" });
      await setup.flush();

      expect(offsetWrites).toBe(0);
    } finally {
      renderer.lib.setRenderOffset = originalSetRenderOffset;
      setup.renderer.destroy();
    }
  });
});

describe("slash-command popup", () => {
  test("scrolls the visible window to keep keyboard selection on screen", async () => {
    const store = createFooterStore(STATUS, {
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    const setup = await testRender(() => App({ store }), {
      width: 100,
      height: 24,
      screenMode: "split-footer",
      footerHeight: 12,
      externalOutputMode: "capture-stdout",
      autoFocus: false,
    });

    try {
      await setup.flush();
      await setup.mockInput.typeText("/");
      for (let i = 0; i < 6; i++) setup.mockInput.pressArrow("down");
      await setup.flush();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("❯ /undo");
      expect(frame).not.toContain("/sessions");
    } finally {
      setup.renderer.destroy();
    }
  });
});
