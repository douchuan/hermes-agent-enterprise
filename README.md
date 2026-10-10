# Hermes Agent 企业部署实践

本仓库用于撰写《Hermes Agent 企业部署实践》，采用 Markdown + Git 进行内容管理，并计划使用 GitBook 发布在线版本。

## 写作目标

以企业部署为主线，以安全治理为核心，逐步构建一套可理解、可验证、可扩展的 Hermes Agent 企业部署参考架构。

## 目录

- `SUMMARY.md`：书籍导航
- `preface/`：前言
- `part-1-foundations/`：Hermes 与企业部署基础
- `part-2-infrastructure/`：身份、Sandbox 与网络隔离
- `part-3-governance/`：工具访问、凭证与审批
- `part-4-security-operations/`：可观测性、安全治理与生命周期
- `part-5-implementation/`：端到端实现与安全验收
- `appendix/`：术语表与参考资料
- `assets/diagrams/`：书籍插图与架构图
- `examples/`：配套实验与配置示例

## 写作约定

1. 每章单独存放为 Markdown 文件。
2. 先说明问题、威胁和设计目标，再解释机制与实现。
3. 对代码和配置给出前置条件、验证步骤与适用边界。
4. 区分公开资料明确披露的事实、合理推导和本书自行实现的方案。
5. 对未经验证的配置明确标注，不声称其已经过生产验证。
6. 外部资料保留可核验的来源链接和访问日期。

## 推荐写作流程

1. 先审阅 `SUMMARY.md` 和各部分简介。
2. 让 AI 每次撰写或修订一章。
3. 使用 Git Diff 审阅改动。
4. 验证命令、YAML 与代码示例。
5. 在 GitBook 中预览导航、图示、表格和链接。
