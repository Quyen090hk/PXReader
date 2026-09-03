# P5Reader

一个女神异闻录 5 风格的浏览器端阅读器原型，已完成第一阶段能力：

- 导入并打开 EPUB、TXT、PDF
- 统一 Reader 页面
- IndexedDB 保存导入书籍
- localStorage 记录阅读进度
- 目录导航
- 正文搜索
- Phantom / Light / Night / Sepia 主题切换
- 选中文字添加高亮和笔记
- PDF text layer，可选择 PDF 文本并标注
- EPUB 内部 CSS 读取、资源 URL 重写和分页模式
- Web Worker 全文索引
- Tauri v2 桌面化项目骨架
- 桌面端原生导入默认打开 `文档/P5Reader/Books`，导入后先加入书架

## 运行

建议在项目目录启动一个静态服务。Web Worker 在 `file://` 下通常不可用：

```powershell
python -m http.server 5173
```

然后访问：

```text
http://localhost:5173
```

EPUB 解析使用打包后的本地 JSZip，PDF 渲染使用本地 PDF.js，桌面版断网也可完整阅读。TXT 会在本地尝试 UTF-8、GB18030、Big5 编码。

如果安装 npm 依赖，也可以用：

```powershell
npm.cmd run serve
```

质量检查：

```powershell
npm.cmd run check
```

## 桌面版

项目已补 Tauri v2 骨架：

```powershell
npm install
npm.cmd run tauri:dev
```

打包：

```powershell
npm.cmd run tauri:build
```

Tauri 会先执行 `npm.cmd run build:web`，把 `index.html` 和 `src/` 复制到 `dist/`，再由 Rust 侧打包。
Windows 打包目标当前收窄为 NSIS，优先生成 `-setup.exe`，避免首次构建就要求 MSI/VBSCRIPT。

如果当前 PowerShell 找不到 `cargo`，但 Rust 已安装在用户目录，可以先临时补 PATH：

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
```

当前 Windows 构建产物：

```text
src-tauri/target/release/p5reader.exe
src-tauri/target/release/bundle/nsis/P5Reader_0.1.0_x64-setup.exe
```

## 架构

核心逻辑位于 `src/app.js`：

- `TxtAdapter`
- `EpubAdapter`
- `PdfAdapter`

三种格式都暴露统一能力：`load`、`render`、`getToc`、`search`、`getIndexUnits`、`next`、`prev`、`getPercentage`。上层 Reader 只处理当前位置、进度、目录、搜索结果和注释模型。

全文索引位于 `src/search-worker.js`，使用 Worker 维护倒排索引，并在主线程不可用时回退到适配器直接扫描。
