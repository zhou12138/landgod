# 📦 发布 LandGod 到 npm 公共仓库

将 LandGod Worker (`landgod`) 和 Gateway (`landgod-gateway`) 发布到 [npmjs.com](https://www.npmjs.com/)，让用户可以直接 `npm install -g landgod` 安装。

## 前置条件

| 条件 | 说明 |
|------|------|
| npm 账号 | 在 [npmjs.com/signup](https://www.npmjs.com/signup) 注册 |
| 2FA | npm 强制要求启用双因素认证 |
| Node.js ≥ 18 | `node -v` 检查 |
| npm ≥ 9 | `npm -v` 检查 |

## 1. 登录 npm

```bash
npm login
```

按提示输入用户名、密码、邮箱，浏览器完成 2FA 验证。

验证登录状态：
```bash
npm whoami
```

## 2. 检查包名可用性

```bash
npm view landgod
# 返回 404 = 可用
```

> 💡 如果名字被占，可以用 scoped 包名：`@your-scope/landgod`

## 3. 准备 package.json

发布前确保以下字段完整：

```json
{
  "name": "landgod",
  "version": "0.1.8",
  "description": "AI-driven remote device management — LandGod Worker Node",
  "license": "MIT",
  "author": "LandGod",
  "repository": {
    "type": "git",
    "url": "https://github.com/zhou12138/cli-server.git"
  },
  "homepage": "https://github.com/zhou12138/cli-server",
  "keywords": ["landgod", "remote", "device-management", "worker", "mcp", "ai-agent"],
  "bin": {
    "landgod": "bin/landgod.js"
  },
  "files": [
    "bin/",
    ".vite/build/",
    ".vite/renderer/",
    "mcp-servers/",
    "mcp-servers/shiproom-mcp/"
  ]
}
```

### 关键字段说明

| 字段 | 用途 |
|------|------|
| `name` | npm 包名，全局唯一 |
| `version` | 语义化版本，每次发布必须递增 |
| `license` | 开源许可证（MIT / Apache-2.0 / ISC 等） |
| `repository` | GitHub 仓库地址，npm 页面会显示 |
| `files` | 控制发布哪些文件（白名单模式） |
| `bin` | CLI 命令入口 |
| `keywords` | npm 搜索关键词 |

## 4. 发布

### 方式一：从源码目录发布

```bash
cd /path/to/landgod-source
npm publish --access public
```

### 方式二：从 tgz 发布

```bash
npm publish downloads/landgod-0.1.8.tgz --access public
```

> `--access public` 确保包公开可见（非 scoped 包默认 public，但显式指定更安全）。

### 首次发布 vs 更新

- **首次发布**：直接 `npm publish`
- **更新版本**：先改 `version`，再 `npm publish`
  ```bash
  npm version patch   # 0.1.8 → 0.1.9
  npm version minor   # 0.1.8 → 0.2.0
  npm version major   # 0.1.8 → 1.0.0
  npm publish --access public
  ```

## 5. 验证发布

```bash
# 查看包信息
npm view landgod

# 全局安装测试
npm install -g landgod

# 验证 CLI 可用
landgod --version
```

## 6. 后续维护

### 撤回版本（72 小时内）

```bash
npm unpublish landgod@0.1.8
```

> ⚠️ 超过 72 小时或有依赖者无法撤回。

### 标记 deprecate

```bash
npm deprecate landgod@"< 0.2.0" "请升级到 0.2.0+"
```

### 添加协作者

```bash
npm owner add <npm-username> landgod
```

### 查看下载量

```bash
npm info landgod
# 或访问 https://www.npmjs.com/package/landgod
```

## 7. CI/CD 自动发布（可选）

GitHub Actions 示例：

```yaml
# .github/workflows/npm-publish.yml
name: Publish to npm
on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

> 在 npmjs.com → Access Tokens 生成 Automation token，存到 GitHub repo 的 Secrets 里。

## 注意事项

- ⚠️ `electron` 放在 `optionalDependencies`，headless 模式不需要 Electron
- ⚠️ `devDependencies` 不会被 `npm publish` 包含
- ⚠️ `.npmignore` 或 `files` 字段控制发布内容，避免泄露源码/密钥
- ⚠️ 发布前用 `npm pack --dry-run` 检查会包含哪些文件
- ⚠️ 包名一旦发布，即使 unpublish 也有 24 小时冷却期不能重新使用
