---
name: image-read
description: 读取/理解图片内容（任何需要从图片中获取信息的情况）：查看截图、分析 UI 界面图、读取数据可视化图表、识别图片中的文字（OCR）、理解示意图/流程图/架构图、描述图片内容等。当用户提供图片路径、提到"这张图/截图/图片里有什么"、或任何需要读取图片内容的请求时，必须使用本 skill，通过统一模型 image-read（OpenAI 兼容接口，网关自动路由）完成。Triggers on: image, screenshot, picture, photo, 图片, 截图, 看图, 读取图片, 识别图片, OCR。
user-invocable: true
allowed-tools:
  - Bash(bash .claude/skills/image-read/scripts/read-image.sh *)
  - Bash(curl http://10.12.135.150:7800/openai/v1/chat/completions *)
---

# image-read — 读取图片内容

凡是需要读取图片内容的场景，**一律**使用本 skill，通过统一模型 `image-read` 识别图片，而不是直接猜测图片内容。网关会根据 `image-read` 这个模型名自动路由到合适的视觉模型，无需关心底层具体模型。

## 适用场景

- 查看/描述用户提供的截图、UI 图、设计稿
- 从图片中提取文字（OCR）
- 理解图表、数据可视化、示意图、流程图、架构图
- 比较多张图片
- 用户问"这张图里是什么 / 图上写了什么 / 这是什么界面"等

## 工作流程

1. **确认图片路径**：拿到图片的本地绝对路径（必要时先用 `find`/`ls` 确认文件存在）。如果用户只粘贴了图片，提示其提供图片路径。
2. **调用脚本**（默认提示词为"请详细描述这张图片的内容"，可按需传 `-p`）：

   ```bash
   bash .claude/skills/image-read/scripts/read-image.sh <图片路径>
   # 自定义提示词 / OCR / 多图：
   bash .claude/skills/image-read/scripts/read-image.sh -p "提取图中所有文字" <图片路径>
   bash .claude/skills/image-read/scripts/read-image.sh <图1> <图2> -p "对比这两张图的内容"
   ```

3. **直接输出模型返回的文本**（脚本已自动提取 `content`，为空时回退 `reasoning_content`），作为对用户问题的回答。调用失败时如实反馈错误，不要编造图片内容。

## 底层 API（OpenAI 兼容）

- **Endpoint**：`http://10.12.135.150:7800/openai/v1/chat/completions`（v0.12.0 起 `/v1` 拆分为 `/openai/v1` 与 `/anthropic/v1`）
- **Model**：`image-read`（网关自动路由到合适模型）
- **Auth**：`Authorization: Bearer sk-myapikey--Je5xkIdBtiyJT9oTuzEqoCFse5OYLIZ`
- 可用环境变量覆盖：`IMAGE_READ_API_URL` / `IMAGE_READ_API_KEY` / `IMAGE_READ_PROMPT`

请求体格式（图片以 base64 data URL 传入）：

```json
{
  "model": "image-read",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "请详细描述这张图片的内容"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,<base64>"}}
      ]
    }
  ]
}
```

## 注意事项

- **优先使用辅助脚本** `read-image.sh`：负责 base64 编码、构造请求、解析响应，并通过临时文件传 body，避免大图时命令行参数超长（Linux 单参数上限 128KB）。
- 支持 png/jpg/jpeg/gif/webp/bmp，脚本按扩展名自动推断 mime type。
- 不要把用户的图片内容写到日志或公开渠道之外的地方。
