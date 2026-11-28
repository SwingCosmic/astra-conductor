import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it, vi } from "vitest";
import {
  ActionButton,
  AppIcon,
  AppShell,
  CollapsiblePanel,
  ConfigField,
  DropdownMenu,
  RichSelect,
  SegmentedControl,
  TagToggleGroup,
  isIconName,
  listIconNames,
  registerIcon,
} from "../src/index";

describe("shared UI icons and form controls", () => {
  it("renders shared SVG sidebar icons in AppShell and preserves fallback text", () => {
    const wrapper = mount(AppShell, {
      props: {
        brand: { name: "GraphAgent", icon: "brand.svg", theme: "purple" },
        activeId: "providers",
        navigation: [
          { id: "home", label: "测试对话", icon: "chat" },
          { id: "models", label: "模型配置", icon: "models" },
          { id: "providers", label: "供应商", icon: "providers" },
          { id: "credentials", label: "凭据管理", icon: "credentials" },
        ],
      },
    });
    const buttons = wrapper.findAll("nav button");
    expect(buttons).toHaveLength(4);
    for (const btn of buttons) {
      expect(btn.find("svg.app-icon").exists()).toBe(true);
    }
    expect(isIconName("providers")).toBe(true);
    expect(isIconName("usage")).toBe(true);
    expect(isIconName("settings")).toBe(true);
    expect(isIconName("nonexistent-icon")).toBe(false);
    wrapper.unmount();

    const iconWrapper = mount(AppIcon, { props: { name: "providers", size: 20 } });
    expect(iconWrapper.get("svg").attributes("width")).toBe("20");
    iconWrapper.unmount();

    expect(listIconNames()).toContain("edit");
    expect(listIconNames()).toContain("trash");
    expect(listIconNames()).toContain("refresh");

    registerIcon("custom-bolt-test", { paths: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"] });
    expect(isIconName("custom-bolt-test")).toBe(true);
    const customIcon = mount(AppIcon, { props: { name: "custom-bolt-test", size: 16 } });
    expect(customIcon.find("path").attributes("d")).toContain("M13 2");
    customIcon.unmount();
  });

  it("supports searchable filtering and keyboard selection in RichSelect", async () => {
    const wrapper = mount(RichSelect, {
      props: {
        label: "供应商",
        modelValue: "",
        placeholder: "选择供应商",
        searchPlaceholder: "搜索供应商",
        searchable: true,
        options: [
          { value: "codex", label: "OpenAI Codex", showMark: true },
          { value: "glm", label: "BigModel Coding Plan", showMark: true },
          { value: "custom-1", label: "中转站 A", tag: "API Key", tagTone: "green" },
        ],
      },
    });

    const trigger = wrapper.get('[role="combobox"]');
    expect(trigger.text()).toContain("选择供应商");
    await trigger.trigger("click");
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);

    await wrapper.get('input[type="search"]').setValue("中转站");
    const filtered = wrapper.findAll('[role="option"]');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.text()).toContain("中转站 A");
    expect(filtered[0]?.text()).toContain("API Key");

    await wrapper.get(".rich-select-popover").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("select")).toEqual([["custom-1"]]);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("supports keyboard navigation and Escape dismissal in RichSelect", async () => {
    const wrapper = mount(RichSelect, {
      props: {
        label: "账号",
        modelValue: "",
        options: [
          { value: "*", label: "全部账号", iconName: "users", tag: "供应商默认" },
          { value: "a1", label: "dev@example.com", iconName: "user", tag: "浏览器 OAuth" },
        ],
      },
    });
    const trigger = wrapper.get('[role="combobox"]');
    await trigger.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    await trigger.trigger("keydown", { key: "ArrowDown" });
    await trigger.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("select")).toEqual([["a1"]]);

    await trigger.trigger("click");
    await trigger.trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("works cleanly inside ConfigField without label re-opening and supports size='sm' + v-model", async () => {
    const onUpdate = vi.fn();
    const Host = defineComponent({
      components: { ConfigField, RichSelect },
      setup() {
        return {
          onUpdate,
          options: [
            { value: "", label: "全部" },
            { value: "gemini-generate-content", label: "Gemini GenerateContent" },
          ],
        };
      },
      template:
        '<ConfigField label="协议端点"><RichSelect size="sm" model-value="" :options="options" @update:model-value="onUpdate" /></ConfigField>',
    });
    const wrapper = mount(Host);
    expect(wrapper.get(".rich-select").classes()).toContain("rich-select--sm");
    const trigger = wrapper.get('[role="combobox"]');
    expect(trigger.text()).toContain("全部");
    await trigger.trigger("click");
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    const opt = wrapper.get('[data-value="gemini-generate-content"]');
    await opt.trigger("click");
    expect(onUpdate).toHaveBeenCalledWith("gemini-generate-content");
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders SegmentedControl and TagToggleGroup states cleanly", async () => {
    const seg = mount(SegmentedControl, {
      props: {
        modelValue: "unknown",
        ariaLabel: "工具调用",
        options: [
          { value: "supported", label: "支持" },
          { value: "unsupported", label: "不支持" },
          { value: "unknown", label: "未知" },
        ],
      },
    });
    const radios = seg.findAll('[role="radio"]');
    expect(radios[2]?.attributes("aria-checked")).toBe("true");
    await radios[0]!.trigger("click");
    expect(seg.emitted("update:modelValue")).toEqual([["supported"]]);
    seg.unmount();

    const tags = mount(TagToggleGroup, {
      props: {
        values: ["text"],
        options: [
          { value: "text", label: "文本" },
          { value: "image", label: "图像" },
        ],
      },
    });
    const buttons = tags.findAll("button");
    expect(buttons[0]?.attributes("aria-pressed")).toBe("true");
    expect(buttons[1]?.attributes("aria-pressed")).toBe("false");
    await buttons[1]!.trigger("click");
    expect(tags.emitted("toggle")).toEqual([["image"]]);
    tags.unmount();
  });

  it("renders ConfigField label, unit, source badge, and reset action", async () => {
    const wrapper = mount(ConfigField, {
      props: {
        label: "最大输出",
        unit: "tokens",
        source: "当前账号覆盖",
        resettable: true,
      },
      slots: { default: '<input type="number" value="32768" />' },
    });
    expect(wrapper.get("label > span").text()).toBe("最大输出");
    expect(wrapper.get(".config-field-unit").text()).toBe("tokens");
    expect(wrapper.get(".config-source-badge").classes()).toContain("is-override");
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("reset")).toHaveLength(1);
    wrapper.unmount();
  });

  it("supports uncontrolled, controlled, lazy, and disabled states in CollapsiblePanel", async () => {
    const uncontrolled = mount(CollapsiblePanel, {
      props: {
        title: "高级参数",
        summary: "默认配置",
        variant: "card",
      },
      slots: { default: "<p class='body-copy'>内容主体</p>" },
    });

    const trigger = uncontrolled.get(".collapsible-trigger");
    const region = uncontrolled.get('[role="region"]');
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.attributes("aria-controls")).toBe(region.attributes("id"));
    expect(region.attributes("aria-labelledby")).toBe(trigger.attributes("id"));
    expect(region.attributes("aria-hidden")).toBe("true");
    expect(uncontrolled.attributes("data-open")).toBe("false");

    await trigger.trigger("click");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(region.attributes("aria-hidden")).toBe("false");
    expect(uncontrolled.attributes("data-open")).toBe("true");
    expect(uncontrolled.emitted("update:open")).toEqual([[true]]);
    uncontrolled.unmount();

    vi.useFakeTimers();
    const lazyPanel = mount(CollapsiblePanel, {
      props: { title: "惰性面板", lazy: true },
      slots: { default: "<span class='lazy-content'>已挂载</span>" },
    });
    expect(lazyPanel.find(".lazy-content").exists()).toBe(false);
    await lazyPanel.get(".collapsible-trigger").trigger("click");
    expect(lazyPanel.find(".lazy-content").exists()).toBe(true);
    await lazyPanel.get(".collapsible-trigger").trigger("click");
    vi.advanceTimersByTime(200);
    await lazyPanel.vm.$nextTick();
    expect(lazyPanel.find(".lazy-content").exists()).toBe(false);
    lazyPanel.unmount();
    vi.useRealTimers();

    const controlled = mount(CollapsiblePanel, {
      props: { title: "受控面板", open: false, disabled: true },
      slots: { default: "<span>受控内容</span>" },
    });
    await controlled.get(".collapsible-trigger").trigger("click");
    expect(controlled.emitted("update:open")).toBeUndefined();
    expect(controlled.attributes("data-open")).toBe("false");
    controlled.unmount();
  });

  it("renders ActionButton variants, loader spinner, loading label, and aria-busy", () => {
    expect(isIconName("loader")).toBe(true);

    const idle = mount(ActionButton, {
      props: { variant: "accent", size: "sm", icon: "plus" },
      slots: { default: "添加账号" },
    });
    expect(idle.classes()).toContain("accent-action");
    expect(idle.classes()).toContain("action-btn--sm");
    expect(idle.attributes("aria-busy")).toBeUndefined();
    expect(idle.attributes("disabled")).toBeUndefined();
    expect(idle.text()).toContain("添加账号");
    idle.unmount();

    const loading = mount(ActionButton, {
      props: {
        variant: "primary",
        loading: true,
        loadingLabel: "检查中…",
        icon: "refresh",
        minWidth: "110px",
      },
      slots: { default: "检查最新版本" },
    });
    expect(loading.classes()).toContain("primary-action");
    expect(loading.attributes("aria-busy")).toBe("true");
    expect(loading.attributes("disabled")).toBeDefined();
    expect(loading.find("svg.app-icon.is-spinning").exists()).toBe(true);
    expect(loading.text()).toBe("检查中…");
    expect(loading.attributes("style")).toContain("min-width: 110px");
    loading.unmount();
  });

  it("supports keyboard navigation, selection, and Escape dismissal in DropdownMenu", async () => {
    const wrapper = mount(DropdownMenu, {
      props: {
        ariaLabel: "更多账号操作",
        items: [
          { id: "rebind", label: "变更绑定", icon: "server" },
          { id: "disable", label: "停用", disabled: true },
          { id: "delete", label: "删除账号", icon: "trash", danger: true },
        ],
      },
    });

    const trigger = wrapper.get('[aria-haspopup="menu"]');
    expect(trigger.attributes("aria-expanded")).toBe("false");
    await trigger.trigger("click");
    expect(trigger.attributes("aria-expanded")).toBe("true");

    const items = wrapper.findAll('[role="menuitem"]');
    expect(items).toHaveLength(3);
    expect(items[1]?.attributes("disabled")).toBeDefined();
    expect(items[2]?.classes()).toContain("is-danger");

    await wrapper.get('[role="menu"]').trigger("keydown", { key: "ArrowDown" });
    await items[2]!.trigger("click");
    expect(wrapper.emitted("select")).toEqual([["delete"]]);
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);

    await trigger.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    await wrapper.get('[role="menu"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
