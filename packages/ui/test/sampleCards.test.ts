import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../src/App.vue";
import QuotaCard from "../src/components/QuotaCard.vue";
import { sampleCards } from "../src/fixtures/sampleCards";

function card(id: string) {
  const found = sampleCards.find((item) => item.id === id);
  if (!found) {
    throw new Error(`missing sample card ${id}`);
  }
  return found;
}

describe("sample cards", () => {
  it("shows hardcoded quota copy and no controls", () => {
    const wrapper = mount(App);
    const text = wrapper.text();

    expect(text).toContain("示例数据");
    expect(text).toContain("Antigravity");
    expect(text).toContain("Starter");
    expect(text).toContain("Gemini Models");
    expect(text).toContain("Claude and GPT models");
    expect(text).toContain("5 Hour Quota");
    expect(text).toContain("Codex");
    expect(text).toContain("Plus");
    expect(text).toContain("5-hour");
    expect(text).toContain("Reset credits");
    expect(text).toContain("Grokpro");
    expect(text).toContain("GrokChat");
    expect(text).toContain("Extra Usage Credits");
    expect(text).toContain("Auto Top-Up");
    expect(text).toContain("Unavailable");
    expect(text).toContain("glm-cn");
    expect(text).toContain("Lite");
    expect(text).toContain("5 Hours Quota");
    expect(text).toContain("Weekly Quota");
    expect(text).toContain("已用 2,563 / 10,000");
    expect(text).not.toContain("Session");

    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find("input, textarea, select, a").exists()).toBe(false);
  });

  it("keeps an untitled Codex group and groups Antigravity quotas", () => {
    const codex = mount(QuotaCard, { props: { card: card("codex") } });
    expect(codex.find(".group-title").exists()).toBe(false);
    expect(codex.text()).toContain("5-hour");
    expect(codex.text()).toContain("Weekly");

    const antigravity = mount(QuotaCard, { props: { card: card("antigravity") } });
    const titles = antigravity.findAll(".group-title").map((node) => node.text());
    expect(titles).toEqual(["Gemini Models", "Claude and GPT models"]);
    expect(antigravity.find(".tone-low").exists()).toBe(true);
    expect(antigravity.find(".tone-critical").exists()).toBe(true);
  });
});
