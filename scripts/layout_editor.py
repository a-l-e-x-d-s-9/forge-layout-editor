"""Forge Neo tab registration. All editor assets are local and loaded by Forge."""
import gradio as gr
from modules import script_callbacks


def layout_ui():
    with gr.Blocks(analytics_enabled=False) as tab:
        gr.HTML('''<div id="forge-layout-shell">
          <div class="forge-layout-intro">
            <strong>Forge Layout Editor</strong>
            <span>Draw areas and describe each subject or text. Generate uses your current txt2img settings.</span>
          </div>
          <div id="forge-layout-host-options">
            <label>LoRA tags <input id="forge-layout-loras" type="text"
              placeholder="Optional: &lt;lora:name:1&gt;" aria-label="LoRA tags"></label>
            <span id="forge-layout-settings" role="status"></span>
          </div>
          <div id="forge-layout-editor"></div>
        </div>''')
    return [(tab, "Forge Layout Editor", "forge_layout_editor")]


script_callbacks.on_ui_tabs(layout_ui)
