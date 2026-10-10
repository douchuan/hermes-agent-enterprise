# 第 5 章：为每位员工构建隔离的 Agent Sandbox

> 状态：待撰写

## 本章目标

为员工提供相互隔离的 Agent 执行环境，并限制运行时可能造成的影响范围。

## 建议内容

- 为什么不能让所有员工共享一个 Agent 进程
- Pod 隔离与 Namespace 隔离分别解决什么问题
- 独立工作目录、配置、Memory、会话和持久化数据
- Linux 容器安全：非 root、只读文件系统、Capabilities、Seccomp
- CPU、内存、进程数量和执行时间限制
- Kubernetes ServiceAccount 的最小权限配置
- 普通容器隔离与 gVisor、Kata Containers 等方案的取舍
- Sandbox 创建、重启、回收与故障恢复

## 本章产出

- 可部署的个人 Agent Sandbox 配置
- 员工间隔离验证实验
- Sandbox 生命周期设计
