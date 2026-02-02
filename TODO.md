# TODO

## 本地大模型安全检查

使用 Ollama 等本地大模型对消息进行安全检查：

### 输入检查（发送给主 AI 之前）
- 检测 prompt injection
- 检测越狱尝试
- 检测社工攻击

### 输出检查（返回给用户之前）
- 检测敏感信息泄露：password、token、api_key、secret、私钥等
- 正则快速检查 + LLM 深度检查

### 实现方案
- 调用 Ollama HTTP API (`localhost:11434`)
- 可用模型：llama3、phi3 等小模型
- 检查失败时的处理策略待定（阻止/警告/记录）

## Bot 授权功能

### 未来：支持 delegate 给 bot
- 允许授权另一个 AI bot 控制 OpenCode
- 需要限制 bot 的 shell 命令权限（`!` 前缀）
- 人类用户暂不限制 shell 权限
