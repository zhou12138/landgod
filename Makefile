# ============================================
# LandGod Makefile — 构建所有安装包
# ============================================
#
# 用法:
#   make          构建所有安装包
#   make worker   只构建 Worker 包
#   make gateway  只构建 Gateway 包 (Node.js + Python)
#   make clean    清理构建产物
#
# 产物输出到 downloads/ 目录
# ============================================

DOWNLOADS_DIR = downloads
WORKER_SRC = .
GATEWAY_NODE_SRC = gateway/node-gateway
GATEWAY_PY_SRC = gateway/python-sdk
GATEWAY_PY_SERVER_SRC = gateway/python-gateway

# 产物文件名（从各 package/pyproject 自动读取版本，避免写死旧版本）
WORKER_VERSION := $(shell node -p "require('./package.json').version")
GATEWAY_NODE_VERSION := $(shell node -p "require('./gateway/node-gateway/package.json').version")
GATEWAY_PY_VERSION := $(shell python3 -c "import tomllib; print(tomllib.load(open('gateway/python-sdk/pyproject.toml','rb'))['project']['version'])")
GATEWAY_PY_SERVER_VERSION := $(shell python3 -c "import tomllib; print(tomllib.load(open('gateway/python-gateway/pyproject.toml','rb'))['project']['version'])")

WORKER_PKG = $(DOWNLOADS_DIR)/landgod-$(WORKER_VERSION).tgz
GATEWAY_NODE_PKG = $(DOWNLOADS_DIR)/landgod-gateway-$(GATEWAY_NODE_VERSION).tgz
GATEWAY_PY_WHL = $(DOWNLOADS_DIR)/landgod_gateway-$(GATEWAY_PY_VERSION)-py3-none-any.whl
GATEWAY_PY_SDIST = $(DOWNLOADS_DIR)/landgod_gateway-$(GATEWAY_PY_VERSION).tar.gz
GATEWAY_PY_SERVER_WHL = $(DOWNLOADS_DIR)/landgod_gateway_server-$(GATEWAY_PY_SERVER_VERSION)-py3-none-any.whl
GATEWAY_PY_SERVER_SDIST = $(DOWNLOADS_DIR)/landgod_gateway_server-$(GATEWAY_PY_SERVER_VERSION).tar.gz

.PHONY: all worker gateway gateway-node gateway-python gateway-python-server clean

# ============================================
# 默认目标：编译 + 构建所有包
# ============================================
all: build worker gateway
	@echo ""
	@echo "🏮 所有安装包构建完成："
	@ls -lh $(DOWNLOADS_DIR)/*.tgz $(DOWNLOADS_DIR)/*.whl 2>/dev/null
	@echo ""

# ============================================
# 编译 TypeScript (vite)
# ============================================
.PHONY: build
build:
	@echo "🔨 编译 TypeScript (vite)..."
	cd $(WORKER_SRC) && npm run package 2>&1 | tail -5
	@echo "🔨 构建 headless-entry.js..."
	cd $(WORKER_SRC) && npx esbuild src/main/headless-entry.ts --bundle --platform=node --outfile=.vite/build/headless-entry.js --external:electron --external:bufferutil --external:utf-8-validate --loader:.ts=ts --tsconfig=tsconfig.json 2>&1 | tail -2
	@echo "✅ 编译完成"

# ============================================
# Worker 包 (landgod)
# ============================================
worker: $(WORKER_PKG)

$(WORKER_PKG):
	@echo "📦 构建 LandGod Worker..."
	@mkdir -p $(DOWNLOADS_DIR)
	cd $(WORKER_SRC) && npm pack --quiet
	mv $(WORKER_SRC)/landgod-*.tgz $(WORKER_PKG)
	@echo "✅ Worker 包: $(WORKER_PKG)"

# ============================================
# Gateway 包 (Node.js + Python)
# ============================================
gateway: gateway-node gateway-python gateway-python-server

# Node.js Gateway
gateway-node: $(GATEWAY_NODE_PKG)

$(GATEWAY_NODE_PKG):
	@echo "📦 构建 LandGod-Link Gateway (Node.js)..."
	@mkdir -p $(DOWNLOADS_DIR)
	cd $(GATEWAY_NODE_SRC) && npm pack --quiet
	mv $(GATEWAY_NODE_SRC)/landgod-gateway-*.tgz $(GATEWAY_NODE_PKG)
	@echo "✅ Gateway Node.js 包: $(GATEWAY_NODE_PKG)"

# Python Gateway
gateway-python: $(GATEWAY_PY_WHL) $(GATEWAY_PY_SDIST)

$(GATEWAY_PY_WHL) $(GATEWAY_PY_SDIST):
	@echo "📦 构建 LandGod-Link Gateway (Python)..."
	@mkdir -p $(DOWNLOADS_DIR)
	cd $(GATEWAY_PY_SRC) && (python3 -m build --quiet 2>/dev/null || python3 -m build)
	cp $(GATEWAY_PY_SRC)/dist/landgod_gateway-*.whl $(GATEWAY_PY_WHL)
	cp $(GATEWAY_PY_SRC)/dist/landgod_gateway-*.tar.gz $(GATEWAY_PY_SDIST)
	@echo "✅ Gateway Python 包: $(GATEWAY_PY_WHL) $(GATEWAY_PY_SDIST)"

# Python Gateway Server
gateway-python-server: $(GATEWAY_PY_SERVER_WHL)

$(GATEWAY_PY_SERVER_WHL) $(GATEWAY_PY_SERVER_SDIST):
	@echo "📦 构建 LandGod Gateway Server (Python)..."
	@mkdir -p $(DOWNLOADS_DIR)
	cd $(GATEWAY_PY_SERVER_SRC) && (python3 -m build --quiet 2>/dev/null || python3 -m build)
	cp $(GATEWAY_PY_SERVER_SRC)/dist/landgod_gateway_server-*.whl $(GATEWAY_PY_SERVER_WHL)
	cp $(GATEWAY_PY_SERVER_SRC)/dist/landgod_gateway_server-*.tar.gz $(GATEWAY_PY_SERVER_SDIST)
	@echo "✅ Gateway Server Python 包: $(GATEWAY_PY_SERVER_WHL) $(GATEWAY_PY_SERVER_SDIST)"

# ============================================
# 清理
# ============================================
clean:
	@echo "🧹 清理构建产物..."
	rm -f $(DOWNLOADS_DIR)/*.tgz $(DOWNLOADS_DIR)/*.whl $(DOWNLOADS_DIR)/*.tar.gz
	rm -rf $(GATEWAY_PY_SRC)/dist $(GATEWAY_PY_SRC)/build $(GATEWAY_PY_SRC)/*.egg-info
	rm -rf $(GATEWAY_PY_SERVER_SRC)/dist $(GATEWAY_PY_SERVER_SRC)/build $(GATEWAY_PY_SERVER_SRC)/*.egg-info
	@echo "✅ 清理完成"
