# 第 5 章：为每位员工构建隔离的 Agent Sandbox

## 本章目标

本章详细展开如何在 Kubernetes 中为每位员工构建独立、安全、可管理的 Agent Sandbox。通过本章，读者将理解：

- 为什么多员工共享一个 Agent 进程不可行
- Sandbox 的 Kubernetes 资源组成和隔离机制
- 容器运行时安全的纵深防御配置
- Sandbox 的完整生命周期：创建、运行、暂停、回收和故障恢复
- 如何验证隔离有效性

## 问题背景与使用场景

第 3 章已经建立了总体架构：每位员工运行一个独立的 Hermes Agent Sandbox。这里需要回答的是**如何实现**。

考虑一个 500 人企业的场景：

1. **员工 Alice** 的 Agent 正在分析一份内部文档，并将其中的事实提炼后写入自己的 Memory。
2. **员工 Bob** 的 Agent 正在通过 Tool Gateway 查询 Jira 工单。
3. **员工 Carol** 的 Agent 被一个包含恶意指令的网页 Prompt Injection，尝试读取 `/etc/passwd` 并向外发送数据。

如果所有员工共享同一个 Agent 进程或同一组容器：

- Alice 的 Memory 可能被 Bob 的 Agent 读取。
- Bob 的会话历史可能泄露给 Carol。
- Carol 的 Agent 被误导后，可能读取其他员工的文件。
- 一个 Agent 的内存泄漏或无限循环会影响所有人。

**所以，每位员工必须有一个独立的 Sandbox**，在计算、存储、网络和身份四个维度上相互隔离。本章解决计算和存储隔离；网络隔离由第 6 章展开。

## 威胁模型与设计目标

### 威胁模型

| 威胁 | 来源 | 影响 |
|------|------|------|
| 员工 A 的 Agent 读取员工 B 的文件 | 共享存储、配置错误 | 信息泄露 |
| Agent 进程逃逸容器边界 | 容器运行时漏洞 | 宿主机被控制 |
| Agent 消耗过多资源 | 模型输出异常、工具循环 | 拒绝服务 |
| Agent 使用高权限身份访问 Kubernetes API | 过度授权的 ServiceAccount | 集群被操控 |
| Agent 执行任意 Shell 命令 | Hermes 的 Shell 工具、代码执行工具 | 容器内任意操作 |
| 存储介质被未授权访问（离线磁盘、快照、备份） | 物理介质流出、未加密落盘 | 数据明文泄露 |

### 设计目标

1. **存储隔离**：每个 Sandbox 的工作目录、Memory、配置和会话对其他 Sandbox 不可见。
2. **落盘加密**：所有持久化存储启用透明静态加密，防止离线磁盘、快照和备份中的数据明文泄露。
3. **运行时安全**：采用纵深防御（非 root、只读根文件系统、最小 capabilities、Seccomp、资源限制），降低容器逃逸和滥用的影响。
4. **最小权限身份**：Sandbox 的 ServiceAccount 只拥有完成工作所需的最小权限，默认不授予 Kubernetes API 访问权。
5. **可管理的生命周期**：Sandbox 能按需创建、暂停、恢复和回收，且故障时能自动恢复。
6. **可验证的隔离**：通过正向和负向实验确认隔离有效。

## 架构与工作机制

### 核心原则：One Person, One Namespace, One Pod, One Encrypted Volume

本书采用确定性的隔离策略：**每位员工拥有独立的 Namespace、独立的 Pod、独立的加密持久化存储。**

但需要明确一个关键区分：**员工的个人 Agent 身份不依赖于某一个永久运行的 Pod。**

```
Agent Identity: agent-alice-001     ← 稳定的 Agent 身份（长期存在）
    │
    ├── Runtime Instance:            ← 当前运行的 Pod（可重启、重建）
    │   namespace: hermes-agent-alice
    │   pod: agent
    │
    ├── Persistent State:            ← 持久化状态（Pod 重建后保留）
    │   PVC: agent-data (encrypted)
    │   ├── /home/hermes/workspace
    │   ├── /home/hermes/memory
    │   └── /home/hermes/sessions
    │
    └── User Binding:                ← 服务端维护的员工→Agent 映射
        employee_id: alice
        agent_id: agent-alice-001
        status: active
```

**员工与个人 Agent 的逻辑一对一关系**：

- 每位员工绑定一个长期稳定的个人 Hermes Agent 身份。
- 这个 Agent 持续积累和管理 Memory、Skills、Sessions 和 Workspace。
- 员工不需要针对不同任务选择不同的 Agent——一个 Agent 根据任务选择合适的 Skill 和工具。
- 运行实例（Pod）可以因故障、更新或资源调度而重建，但 Agent 身份和持久化状态保留。
- 多个并发任务可以共享同一个 Agent 身份，但需根据 Hermes 的会话和文件访问机制实施必要的并发控制，不要假设同一 Agent 的并发访问天然安全。

```
hermes-agent-alice/          ← Namespace
  pod/agent                  ← Pod（单实例，可重建）
  pvc/agent-data             ← 加密 PersistentVolume（工作目录 + Memory）
  serviceaccount/agent       ← 最小权限身份
  networkpolicy/default-deny ← 网络策略（第 6 章）

hermes-agent-bob/            ← 完全独立的 Namespace
  ...
```

### Sandbox 的 Kubernetes 资源组成

每个员工的 Sandbox 由以下 Kubernetes 资源组成：

| 资源 | 作用 |
|------|------|
| Namespace | 物理隔离边界，所有资源归属其中 |
| Deployment（replicas: 1） | 运行 Hermes Agent 进程，提供自动重启和更新 |
| PersistentVolumeClaim (加密) | 持久化工作目录、Memory、会话（一个 PVC） |
| ServiceAccount | 最小权限的工作负载身份 |
| ResourceQuota | 该 Namespace 的资源上限 |
| LimitRange | 容器默认资源和上下限 |
| NetworkPolicy | 网络出站控制（第 6 章） |

完整配置见 `examples/05/agent-sandbox.yaml`（Pod）和 `examples/05/agent-deployment.yaml`（Deployment 版本）。

### 关键字段解释

Pod 配置中有几个安全字段需要特别关注，完整配置见 `examples/05/agent-sandbox.yaml`。

**`automountServiceAccountToken: false`**

Agent Sandbox 不需要访问 Kubernetes API。除非有明确需求（例如 Agent 需要查询集群状态，这本身是一个需要严格审批的高风险操作），否则不要开启。

**`runAsNonRoot: true` + `runAsUser: 1000`**

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  runAsNonRoot: true
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
```

进程以 UID 1000 运行，不是 root。`runAsNonRoot: true` 是 Kubernetes 的强制检查——如果镜像的 ENTRYPOINT 是 root，Pod 将无法启动。

**`readOnlyRootFilesystem: true`**

容器的根文件系统是只读的。这防止 Agent 向 `/usr`、`/etc` 等系统目录写入文件。需要写入的目录（workspace、memory、tmp）通过独立的卷挂载。

**`capabilities.drop: ALL`**

```yaml
securityContext:
  capabilities:
    drop: ["ALL"]
```

Linux capabilities 包含约 40 项权限。`drop: ALL` 移除所有 capabilities（包括 `NET_RAW`、`SYS_ADMIN` 等）。

| Capability | 权限 | 为什么要移除 |
|------------|------|-------------|
| `NET_RAW` | 使用 RAW socket，可构造任意网络包 | 可用于网络扫描、ARP 欺骗 |
| `SYS_ADMIN` | 大量系统管理权限（挂载、加载模块等） | 几乎是 root 权限 |
| `SYS_PTRACE` | 追踪其他进程 | 可读取其他进程内存 |
| `DAC_OVERRIDE` | 绕过文件权限检查 | 即使不是 root 也能读任意文件 |
| `CHOWN` | 修改文件所有者 | 可修改其他用户的文件权限 |

**`allowPrivilegeEscalation: false`**

禁止进程通过 `setuid`、`setgid` 或 capabilities 提升权限。

**`tmp` 使用 `emptyDir` with `medium: Memory`**

`/tmp` 挂载为 tmpfs（内存文件系统），限制 256 MiB。临时文件不写磁盘，Sandbox 销毁后自动清除。

**卷挂载：一个 PVC，多个 subPath**

```yaml
volumeMounts:
  - name: data
    mountPath: /home/hermes/workspace
    subPath: workspace
  - name: data
    mountPath: /home/hermes/memory
    subPath: memory
```

工作目录和 Memory 放在同一个加密 PVC 的不同子目录中，减少存储管理复杂度，加密覆盖全部持久化数据。

### ServiceAccount 配置

ServiceAccount 和可选的 Role/RoleBinding 见 `examples/05/agent-service-account.yaml`。

**关键原则**：`automountServiceAccountToken: false` 是默认值。只有当 Agent 明确需要访问 Kubernetes API 时，才创建对应的 Role 和 RoleBinding，并且 `resourceNames` 限定到具体的资源名称（例如只能读取自己的 Pod）。

### ResourceQuota 和 LimitRange

ResourceQuota 和 LimitRange 配置见 `examples/05/resource-quota.yaml` 和 `examples/05/limit-range.yaml`。

ResourceQuota 限制该员工 Sandbox 的总资源消耗（防止创建大量 Pod 消耗集群资源）。LimitRange 为容器设置默认的 request 和 limit，以及上下限。

### 持久化存储：加密 Volume

每个员工的 Sandbox 在其独立 Namespace 中只挂载**一个**加密的 PersistentVolume。StorageClass 和 PVC 配置见 `examples/05/pvc.yaml`。

参考实现（AWS EBS）的 StorageClass 关键字段：

```yaml
provisioner: ebs.csi.aws.com
parameters:
  encrypted: "true"                    # EBS 卷创建时启用加密
  kmsKeyId: "alias/hermes-agent-ebs"   # KMS 密钥（共享 KEK）
reclaimPolicy: Delete                  # PVC 删除时自动销毁底层 EBS 卷
```

#### 透明静态加密：工作原理

透明静态加密（Transparent Encryption at Rest）意味着：

1. **加密发生在存储层**：数据写入磁盘时由存储服务自动加密，读取时自动解密。Hermes Agent 使用标准文件读写接口，不需要感知加解密过程。
2. **KMS 提供密钥**：存储后端从 KMS 获取数据加密密钥（DEK），用于实际加密数据。KMS 本身不直接加解密文件——它管理密钥。
3. **加密覆盖全部落盘数据**：EBS 卷的每个块都经过加密，包括文件系统元数据。

以 AWS EBS 为例的加密流程：

```
Hermes Agent 写入文件
    ↓（标准 ext4 文件系统写入）
EBS 卷（节点侧）
    ↓（从 KMS 获取数据密钥 DEK）
EBS 加密模块
    ↓（使用 DEK 加密数据块）
物理存储介质（密文落盘）
```

- EBS 卷在创建时由 EBS CSI Driver 调用 AWS API 并指定 `encrypted: true` 和 KMS key。
- AWS EBS 为每个卷生成唯一的数据加密密钥（DEK），该 DEK 本身由 KMS 密钥（KEK）加密后存储。
- 当 EBS 卷挂载到 EC2 节点时，节点侧的 EBS 模块透明地解密读取的数据、加密写入的数据。
- 如果 KMS key 被禁用或删除，该 EBS 卷将无法再被挂载（解密失败）。

#### 加密方式取决于存储后端

| 存储后端 | 加密方式 | 说明 |
|----------|----------|------|
| AWS EBS | EBS Encryption + KMS | 卷创建时自动加密，节点侧透明解密 |
| GCP PD | GCE PD Encryption + Cloud KMS | 默认启用 Google 管理的密钥，也可指定 CMK |
| Azure Disk | SSE + CMK | 支持客户管理的密钥（CMK） |
| Ceph RBD | LUKS + cryptsetup | 需要 CSI 驱动支持或 Ceph 原生加密 |
| 自建 Kubernetes | 取决于存储后端 | 必须由实际 CSI 驱动提供加密能力 |

**重要提醒**：Kubernetes PVC 本身不提供加密。`StorageClass` 的 `encrypted: "true"` 只是向 CSI 驱动传递参数，实际加密由 CSI 驱动和底层存储后端实现。如果选用的存储后端没有加密能力，PVC 中的数据将是明文。

#### 密钥层级：DEK 与 KEK

理解以下区别很重要：

| 概念 | 说明 | 谁管理 |
|------|------|--------|
| 数据加密密钥（DEK） | 实际加密数据的密钥，每个 EBS 卷唯一 | 存储后端（如 AWS EBS） |
| 密钥加密密钥（KEK） | 加密 DEK 的密钥，存储在 KMS 中 | KMS（如 AWS KMS） |
| 每员工独立 KMS 密钥 | 每个员工拥有自己的 KMS CMK | KMS + 平台管理 |
| 共享 KMS 密钥 | 所有员工卷共享同一把 KMS CMK | KMS + 平台管理 |

**参考实现采用共享 KEK 方案**：所有员工的 EBS 卷使用同一把 KMS CMK。原因：

- AWS EBS 已经为每个卷生成独立的 DEK。即使使用共享 KEK，不同卷的加密数据密钥也不同。
- 管理简单：500 个员工不需要管理 500 把 KMS 密钥。
- KMS 提供密钥策略、审计和轮换能力，可以控制谁可以使用这把密钥。

**何时需要每员工独立 KMS 密钥？**

- 合规要求（如 PCI DSS、HIPAA）明确要求每个租户独立密钥。
- 需要单独禁用/销毁某个员工的密钥而不影响其他员工。
- 组织层面有严格的密钥隔离策略。

如果采用每员工独立 KMS 密钥，必须额外说明：密钥创建、密钥策略配置、轮换调度、员工离职后密钥销毁的自动化流程。

#### 透明加密的保护边界

**必须明确指出**：透明静态加密主要保护落盘数据（data at rest），并不自动阻止有权限读取已挂载卷的进程访问明文。

因此，以下断言是**错误**的：

- "启用卷加密后，其他员工自然无法访问该卷。" → 错误。需要 RBAC + Namespace 隔离。
- "启用 KMS 后，平台管理员必然无法读取数据。" → 错误。KMS key 策略可能允许管理员使用密钥。
- "数据已经加密，所以无需 RBAC、存储授权或工作负载隔离。" → 错误。加密不替代运行时访问控制。
- "删除 PVC 就一定意味着底层数据、快照和备份均已删除。" → 错误。需要确认 `reclaimPolicy` 和备份策略。

**透明加密能防范的威胁**：

| 威胁 | 未加密 | 加密 |
|------|--------|------|
| 存储后端被入侵（如 Ceph 节点被攻破） | 数据明文可读 | 数据被加密保护 |
| PVC 备份文件泄露 | Memory 内容完全暴露 | 需要 KMS key 才能解密 |
| 磁盘退役后数据残留 | 物理介质可能被恢复 | 密钥销毁即不可读 |
| 快照被未授权下载 | 快照内容明文可读 | 快照继承卷加密 |

## 实现步骤

### 5.1 Control Plane 创建 Sandbox 的流程

Control Plane 在以下时机创建 Sandbox：

1. **员工首次登录**（第 4 章的 OIDC 流程完成后）
2. **管理员手动激活**
3. **Sandbox 被回收后重新激活**

创建流程：

```
Control Plane 收到员工登录事件
    │
    ├─ 检查是否已有活跃 Sandbox
    │   ├─ 有 → 检查健康状态，不健康则重建
    │   └─ 无 → 创建新 Sandbox
    │
    ├─ 生成 Kubernetes 资源
    │   ├─ PVC（加密存储）
    │   ├─ ConfigMap（Agent 配置）
    │   ├─ ServiceAccount（最小权限）
    │   └─ Deployment（replicas: 1）
    │
    ├─ 应用 NetworkPolicy（第 6 章）
    │
    ├─ 等待 Pod Ready（Readiness Probe 通过）
    │
    └─ 更新元数据：employee → sandbox 映射
```

完整的 TypeScript 实现见 `examples/05/control-plane-sandbox.ts`。核心步骤：

1. 创建 Namespace（如果不存在），打上 `employee` 和 `tenant` 标签。
2. 检查是否已有 Sandbox，避免重复创建。
3. 创建加密 PVC，使用 `encrypted-ssd` StorageClass。
4. 创建 ConfigMap，注入 `employee_id`、`tenant_id` 和 Tool Gateway URL。
5. 创建 ServiceAccount，`automountServiceAccountToken: false`。
6. 创建 Deployment（replicas: 1，Recreate 策略）。
7. 等待 Pod Ready。

### 5.2 使用 Deployment 还是直接管理 Pod？

| 方案 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| 直接创建 Pod | 每员工一个独立实例，需要精细控制 | 完全控制 Pod 规格 | 需要自己处理重启、更新 |
| Deployment（replicas: 1） | 需要自动重启、滚动更新 | Kubernetes 自动管理生命周期 | 增加 ReplicaSet 资源开销 |

**建议**：使用 Deployment。自动重启和镜像更新的能力比少量资源开销更重要。

Deployment 配置见 `examples/05/agent-deployment.yaml`。

**注意 `strategy.type: Recreate`**：因为每个员工的 Sandbox 只运行一个 Agent 实例，且 Agent 可能在运行中有状态（正在执行工具调用），使用 `Recreate` 而非 `RollingUpdate`，确保旧 Pod 完全终止后再启动新 Pod。

## 容器运行时安全的纵深防御

容器安全不是单一配置能解决的，需要多层防御。每一层单独看都不够，但组合起来大幅降低了风险。

### 层 1：用户与权限

`runAsNonRoot: true` 是强制检查：无论镜像设置什么，都不能以 root 运行。如果镜像的 Dockerfile 设置了 `USER root`，仅设置 `runAsUser` 不会覆盖它——`runAsNonRoot` 会拒绝启动。

Dockerfile 中应添加：

```dockerfile
RUN adduser --disabled-password --uid 1000 hermes
USER hermes
```

### 层 2：只读根文件系统

容器根文件系统（`/usr`、`/bin`、`/lib` 等）只读。Agent 无法修改系统目录。需要写入的目录通过独立卷挂载。

### 层 3：Capabilities

绝大多数 Agent 场景不需要任何 capabilities。如果 Hermes Agent 需要绑定 1024 以下端口（一般不需要），单独添加 `NET_BIND_SERVICE`。

### 层 4：Seccomp

Seccomp（Secure Computing Mode）限制进程可以调用的系统调用。`RuntimeDefault` 使用容器运行时（containerd/CRI-O）的默认 seccomp 配置文件，只允许常用的系统调用（`read`、`write`、`open`、`close`、`socket` 等），阻断危险系统调用（如 `ptrace`、`mount`、`reboot`）。

与 capabilities 的区别：capabilities 控制"可以做什么操作"，seccomp 控制"可以调用哪些系统调用"。两者互补。

### 层 5：资源限制

同时设置 requests 和 limits。只设置 limits 不设置 requests 会导致调度效率降低；只设置 requests 不设置 limits 会导致 Pod 可能消耗无限资源。

**进程数量限制**：Hermes Agent 在执行某些工具（如 Shell 命令、代码执行）时可能创建子进程。可以在容器启动命令中设置 `ulimit -u`：

```yaml
command: ["/bin/sh", "-c"]
args:
  - |
    ulimit -u 256  # 最大 256 个进程
    exec /usr/bin/hermes-agent --config=/etc/hermes/config.yaml
```

**执行时间限制**：对于 Agent 的单次工具调用（如 Shell 命令），应在 Hermes Agent 层面设置超时，而非在 Kubernetes 层面。

## 更强隔离：gVisor 和 Kata Containers

标准容器（runc）共享宿主机的 Linux 内核。对于执行不可信 Shell 或代码的场景（Agent 可能被 Prompt Injection 诱导执行任意命令），标准容器的隔离可能不够。

### gVisor

[gVisor](https://gvisor.dev/) 在容器进程和宿主机内核之间插入一个用户态内核（`runsc`），拦截系统调用并在用户态处理。

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

在 Pod spec 中添加 `runtimeClassName: gvisor` 即可使用。

**优势**：容器进程无法直接调用宿主机内核的系统调用。兼容 OCI 运行时，使用方式与标准容器相同。

**限制**：不完全支持所有系统调用。CPU 密集场景有 10-20% 的性能损失。

### Kata Containers

[Kata Containers](https://katacontainers.io/) 为每个 Pod 运行一个轻量级虚拟机（VM）。

**优势**：硬件级别的隔离。对内核逃逸攻击的防护强于 gVisor。

**限制**：每个 Pod 需要独立的 VM 内核，内存开销增加约 100-200 MiB。启动时间更长。需要 CPU 虚拟化支持。

### 选型建议

| 场景 | 推荐方案 | 理由 |
|------|----------|------|
| Agent 执行可信工具（内部 API 调用、文档查询） | 标准容器 + 纵深防御 | 性能最好，隔离足够 |
| Agent 可能执行不可信 Shell 命令 | gVisor | 防护内核逃逸，性能开销可接受 |
| 高安全要求（金融、政府）或执行不可信代码 | Kata Containers | 最强隔离，资源开销可接受 |

**重要提醒**：无论选择哪种方案，都不能替代其他安全措施（网络策略、Tool Gateway 授权、最小权限）。更强隔离是纵深防御的又一层，不是替代。

## Sandbox 生命周期管理

### 创建

Control Plane 在员工首次登录或管理员激活时创建 Sandbox（见 5.1 节）。

### 运行中

- **健康检查**：Readiness Probe 和 Liveness Probe 监控 Agent 状态。
- **自动重启**：Deployment 在进程崩溃时自动重启 Pod。
- **资源监控**：通过 OpenTelemetry（第 10 章）监控 CPU、内存、磁盘使用量。

### 暂停

当员工长期不使用 Agent（例如休假），将 Deployment replicas 设为 0。PVC 保留，数据不丢失。恢复时只需将 replicas 设为 1。

### 员工转岗：Sandbox 处理

当员工从一个部门调到另一个部门（如 Alice 从研发部调到市场部），Sandbox 本身**通常不需要重建**。

**默认策略：保留原 Agent 身份，重新评估权限。**

```
Control Plane 收到组织关系变更事件
    │
    ├─ 更新员工部门、角色、团队
    │
    ├─ 立即使平台侧不再允许的授权失效
    │   └─ 更新 Tool Gateway 策略缓存
    │
    ├─ 触发外部授权连接重算（第 7 章）
    │   ├─ 研发部专属 GitHub 团队 → 移除
    │   ├─ 不再适用的 OAuth 连接 → 禁用
    │   └─ 第三方团队成员关系 → 撤销
    │
    ├─ 评估 Memory、Skills、Workspace 中的敏感数据
    │   ├─ 部门级敏感信息 → 根据保留策略处理
    │   └─ 个人非敏感信息 → 保留
    │
    ├─ 检查正在执行的任务
    │   └─ 失去授权的任务 → 终止并通知员工
    │
    └─ 记录所有变更到审计日志（第 10 章）
```

**为什么不需要重建 Sandbox？**

- Agent 的身份（`agentId`）是长期稳定的，不因部门变化而改变。
- Memory 和 Skills 中可能包含对个人有用的非敏感信息，不应盲目删除。
- 重建 Sandbox 的开销远大于权限重算。
- PVC 加密和 Namespace 隔离保证了运行环境的独立性。

**需要重建 Sandbox 的特殊情况**：

- 员工身份主体发生变化（issuer/subject 变更）。
- 原 Sandbox 的完整性或隔离边界受到影响（安全事件）。
- 新旧岗位需要不同的安全等级或运行边界（如从普通员工调到安全审计岗）。
- 无法可靠清理旧环境中的敏感凭证或状态。
- 企业政策明确要求重新建立隔离环境。

即使重建，也不能默认完整复制旧 Memory、Skills 和凭证。需要根据数据分类、来源、授权和保留规则决定迁移范围。

**区分四个不同的决策**：

| 决策 | 说明 | 默认行为 |
|------|------|----------|
| Agent 身份是否保持 | 员工对应的 Agent ID 是否保留 | 保留 |
| Pod 是否重建 | 运行实例是否销毁重建 | 不重建 |
| 持久化状态是否迁移 | Memory、Workspace 是否保留 | 保留，但评估敏感数据 |
| 权限是否重新授予 | 工具调用权限、外部授权是否有效 | 重新评估 |

### 回收

当员工离职或被禁用时，Control Plane 执行回收流程：

```
1. 将 Deployment replicas 设为 0（停止 Pod）
2. 导出审计日志和会话记录（归档到长期存储）
3. 根据数据保留策略处理 PVC：
   a. 需要保留过渡期：保留 PVC，设置 retain 标签
   b. 无需保留：删除 PVC，底层加密 EBS 卷随 reclaimPolicy: Delete 自动销毁
4. 删除整个 Namespace（级联删除其中所有资源）
5. 更新元数据：标记员工为"已回收"
```

**数据保留策略**：

员工离职后，其数据不应立即销毁。建议：

- **30 天保留期**：PVC 标记 `retain=true`，不删除。如有数据恢复需求，可重建 Pod 挂载。
- **保留期结束后**：删除 PVC。由于 `reclaimPolicy: Delete`，底层 EBS 卷被销毁。
- **合规要求**：如果法律法规要求更长的保留期（如 1-7 年），PVC 数据应归档到长期存储（如 AWS S3 Glacier），并加密存储。归档后删除 PVC。

回收流程的 TypeScript 实现见 `examples/05/sandbox-recycle.ts`。

**注意**：参考实现使用共享 KMS 密钥。回收员工时**不需要**销毁或禁用 KMS 密钥——该密钥同时被其他活跃员工使用。如果需要立即阻止某员工数据被解密（极端场景），且使用了每员工独立 KMS 密钥，可以禁用该员工的专属密钥。

### 备份与恢复

每个员工的 PVC 数据需要定期备份，以应对数据损坏、误删或需要回滚的场景。

**备份策略**：

1. **CSI VolumeSnapshot**：使用 Kubernetes CSI VolumeSnapshot 功能，对 EBS 卷创建时间点快照。
2. **加密继承**：EBS Snapshot 自动继承源卷的加密状态。使用 KMS 加密的 EBS 卷，其快照也是加密的。
3. **备份频率**：根据数据重要性设定（如每日一次）。
4. **快照保留**：保留最近 N 个快照或 N 天的快照，过期自动删除。

VolumeSnapshotClass 和 VolumeSnapshot 配置见 `examples/05/volume-snapshot-class.yaml` 和 `examples/05/volume-snapshot.yaml`。

**恢复流程**：

```
1. 从 VolumeSnapshot 创建新的 PVC
2. 将新 PVC 挂载到员工 Sandbox（替换损坏的 PVC）
3. 验证数据完整性
```

从快照恢复 PVC 的配置见 `examples/05/pvc-restore.yaml`。

**恢复注意事项**：

- 恢复的 PVC 使用相同的加密 StorageClass，因此新卷也使用相同的 KMS 密钥加密。
- 恢复操作不应将数据交给错误的员工——新 PVC 必须创建在正确的 Namespace 中。
- 恢复后，更新 Deployment 的 PVC 引用，并重启 Pod。

### 密钥轮换

KMS 密钥需要定期轮换，以降低密钥泄露后的影响窗口。

**AWS KMS 自动轮换**：

- AWS KMS 支持自动轮换 CMK，每年轮换一次。
- 轮换后，KMS 保留旧版本密钥用于解密历史数据。
- **EBS 卷不受 KMS 自动轮换影响**：EBS 卷创建后，其 DEK 不变。
- 如果需要更新现有 EBS 卷的密钥，必须创建新卷并迁移数据。

**手动轮换流程**：

```
1. 在 KMS 中创建新版本的 CMK（或启用新的 CMK）
2. 更新 StorageClass，引用新的 KMS 密钥别名
3. 新建 PVC 使用新密钥
4. 将旧 PVC 数据迁移到新 PVC（rsync 或备份恢复）
5. 更新 Pod 挂载新 PVC
6. 旧 PVC 数据确认迁移完成后，删除旧 PVC
7. 禁用旧 KMS 密钥版本（等待确认无遗留依赖后）
```

**轮换期间的风险控制**：不要在业务高峰期轮换；轮换前确认备份可用；轮换后验证新 PVC 可以正常挂载和读写；禁用旧密钥前，确认没有遗留的快照、备份或离线卷仍依赖旧密钥。

## 验证实验与预期结果

以下实验在 Kubernetes 测试集群中执行，验证 Sandbox 隔离的有效性。

### 实验 1：Namespace 隔离验证

**目标**：验证员工 A 的 Namespace 中的资源对员工 B 不可见。

**步骤**：

```bash
# 1. 在 Alice 的 Namespace 中查看资源
kubectl get all -n hermes-agent-alice

# 2. 在 Bob 的 Namespace 中查看资源
kubectl get all -n hermes-agent-bob

# 3. 尝试从 Bob 的 Pod 访问 Alice 的 Namespace
kubectl exec -n hermes-agent-bob agent -- \
  sh -c 'curl -s http://agent.hermes-agent-alice.svc.cluster.local:8080/healthz'
```

**预期结果**：第三条命令失败（连接被拒绝或 DNS 解析失败），因为 NetworkPolicy 禁止跨 Namespace 访问（第 6 章）。

### 实验 2：存储隔离与加密验证

**目标**：验证每个 Namespace 有独立的加密 PVC，且底层存储确实启用了加密。

**步骤**：

```bash
# 1. 在 Alice 的 Pod 中写入文件
kubectl exec -n hermes-agent-alice agent -- \
  sh -c 'echo "secret from alice" > /home/hermes/workspace/alice-secret.txt'

# 2. 尝试在 Bob 的 Pod 中读取 Alice 的文件
kubectl exec -n hermes-agent-bob agent -- \
  sh -c 'cat /home/hermes/workspace/alice-secret.txt'

# 3. 验证 PVC 使用了加密 StorageClass
kubectl get pvc agent-data -n hermes-agent-alice -o jsonpath='{.spec.storageClassName}'

# 4. 通过 AWS CLI 验证底层 EBS 卷确实加密（参考实现：AWS EBS）
VOLUME_ID=$(kubectl get pvc agent-data -n hermes-agent-alice \
  -o jsonpath='{.spec.volumeName}')
PV_NAME=$(kubectl get pv "$VOLUME_ID" -o jsonpath='{.spec.csi.volumeHandle}')

aws ec2 describe-volumes --volume-ids "$PV_NAME" \
  --query 'Volumes[0].{Encrypted:Encrypted, KmsKeyId:KmsKeyId}'
```

**预期结果**：
- 第二条命令失败（文件不存在）。
- 第四条命令返回 `{"Encrypted": true, "KmsKeyId": "arn:aws:kms:...:alias/hermes-agent-ebs"}`。

**失败判定**：`Encrypted: false` 或 PVC 未使用加密 StorageClass。

### 实验 3-8：容器安全验证

| 实验 | 目标 | 关键命令 | 预期结果 |
|------|------|----------|----------|
| 3. 进程隔离 | A 看不到 B 的进程 | `kubectl exec -n hermes-agent-bob agent -- ps aux` | 只看到自身进程 |
| 4. 非 root 用户 | Agent 不是 root | `kubectl exec -n hermes-agent-alice agent -- id` | `uid=1000` |
| 5. 只读根文件系统 | 无法写系统目录 | `kubectl exec ... -- sh -c 'echo x > /usr/local/bin/test'` | Read-only file system |
| 6. Capabilities | 无 capabilities | `kubectl exec ... -- cat /proc/1/status \| grep Cap` | 全为 0 |
| 7. ResourceQuota | 不能超限制 | 在 Pod 内分配超过 limit 的内存 | OOMKilled |
| 8. Namespace 删除 | 删除 A 不影响 B | `kubectl delete namespace hermes-agent-alice` | B 正常运行 |

### 实验 9：Pod 重建后数据保留验证

**目标**：验证删除并重建员工 A 的 Pod 后，授权保留的数据仍可正常访问。

```bash
# 1. 写入数据
kubectl exec -n hermes-agent-alice agent -- \
  sh -c 'echo "persistent data" > /home/hermes/workspace/important.txt'

# 2. 删除 Pod（Deployment 会自动重建）
kubectl delete pod agent -n hermes-agent-alice

# 3. 等待重建完成
kubectl wait --for=condition=Ready pod/agent -n hermes-agent-alice --timeout=120s

# 4. 验证数据仍在
kubectl exec -n hermes-agent-alice agent -- \
  sh -c 'cat /home/hermes/workspace/important.txt'
```

**预期结果**：输出 `persistent data`。

### 实验 10：备份与恢复验证

**目标**：验证可以从快照恢复 PVC 数据。

```bash
# 1. 创建快照
kubectl apply -f examples/05/volume-snapshot.yaml -n hermes-agent-alice

# 2. 等待快照就绪
kubectl wait --for=jsonpath='{.status.readyToUse}=true' \
  volumesnapshot/agent-data-snapshot -n hermes-agent-alice --timeout=300s

# 3. 从快照创建新 PVC
kubectl apply -f examples/05/pvc-restore.yaml -n hermes-agent-alice
```

**失败判定**：快照创建超时，或恢复的 PVC 中数据缺失。

### 实验 11：KMS 权限隔离验证

**目标**：验证无权管理密钥的身份不能修改关键密钥策略或执行未授权的密钥管理操作。

**前置条件**：AWS 环境，已配置 IAM 角色和 KMS 密钥策略。

```bash
# 1. 使用普通员工角色尝试禁用 KMS 密钥
AWS_PROFILE=hermes-employee aws kms disable-key \
  --key-id "$(aws kms describe-key --key-id alias/hermes-agent-ebs \
    --query 'KeyMetadata.KeyId' --output text)"

# 2. 使用管理员角色验证可读取
AWS_PROFILE=hermes-admin aws kms describe-key \
  --key-id alias/hermes-agent-ebs \
  --query 'KeyMetadata.{KeyId:KeyId,KeyState:KeyState,Enabled:Enabled}'
```

**预期结果**：第一步返回 `AccessDeniedException`，第二步成功返回密钥信息。

### 实验 12：员工离职后数据生命周期验证

**目标**：验证员工离职后，身份、凭证、工作负载和存储数据按照既定策略处理。

```bash
# 1. 确认 Charlie 的 Sandbox 正常运行
kubectl get all -n hermes-agent-charlie

# 2. 执行回收流程（由 Control Plane 执行）

# 3. 验证 Pod 已停止
kubectl get pod agent -n hermes-agent-charlie

# 4. 验证 PVC 数据仍保留（保留期内）
kubectl get pvc agent-data -n hermes-agent-charlie

# 5. 保留期结束后，删除 Namespace
kubectl delete namespace hermes-agent-charlie

# 6. 验证 PVC 已被删除
kubectl get pv | grep charlie
```

**预期结果**：Pod 停止后数据不可访问，保留期结束后 PVC 和底层加密卷被销毁。

## 常见问题与故障排查

### Pod 无法启动：`RunAsNonRoot` 检查失败

**症状**：Pod 状态为 `CreateContainerConfigError`，事件显示 `container has runAsNonRoot and image will run as root`。

**解决**：在 Dockerfile 中添加 `USER hermes`（UID 1000 的非 root 用户）。

### PVC 无法挂载

**症状**：Pod 状态为 `ContainerCreating`，事件显示 `Unable to attach or mount volumes: timed out waiting for the condition`。

**解决**：`kubectl get storageclass` 确认 StorageClass，`kubectl describe pvc agent-data -n hermes-agent-alice` 查看详细事件。

### Agent 启动后立即退出

**排查步骤**：`kubectl logs agent -n hermes-agent-alice` 查看日志，确认配置文件路径、环境变量和 PVC 权限。

### 容器内无法写入文件

**原因**：`readOnlyRootFilesystem: true` 生效，但尝试写入的目录没有通过卷挂载。确认所有需要写入的目录都在 `volumeMounts` 中声明。

## 安全边界、取舍与剩余风险

### 本章方案能防范什么

| 威胁 | 防范机制 | 有效性 |
|------|----------|--------|
| 员工 A 读取员工 B 的文件 | 独立 Namespace + 独立 PVC | 强 |
| 员工 A 的 Namespace 被误删影响员工 B | Namespace 隔离 | 强 |
| Agent 修改系统文件 | 只读根文件系统 | 强 |
| 容器进程以 root 运行 | runAsNonRoot + UID 1000 | 强 |
| 进程使用危险 capabilities | drop: ALL | 强 |
| 进程通过系统调用攻击内核 | Seccomp RuntimeDefault | 中 |
| 单个 Agent 消耗过多资源 | ResourceQuota | 强 |
| Agent 访问 Kubernetes API | automountServiceAccountToken: false | 强 |
| 存储后端被入侵时数据泄露 | PVC 透明静态加密 + KMS | 强 |
| PVC 备份/快照泄露 | 加密卷的备份继承加密 | 强 |
| 磁盘退役后数据残留 | 密钥销毁即不可读 | 强 |
| 未授权身份修改 KMS 密钥策略 | KMS 最小权限策略 | 强 |

### 本章方案不能防范什么

| 威胁 | 需要补充的措施 |
|------|----------------|
| Agent 被 Prompt Injection 误导后通过 Tool Gateway 发起恶意工具调用 | Tool Gateway 授权 + 审批（第 7、9 章） |
| Agent 通过网络直接连接外部系统 | NetworkPolicy + Egress Proxy（第 6 章） |
| 内核漏洞导致容器逃逸（标准容器） | gVisor 或 Kata Containers |
| Hermes Agent 镜像中的供应链漏洞 | 镜像签名验证、SBOM、漏洞扫描（第 12 章） |
| 有挂载权限的进程读取 PVC 明文数据 | 加密保护落盘数据，运行时隔离依赖 Namespace + RBAC |
| 控制平面被攻破后任意 Namespace 操作 | 控制平面自身的安全加固（第 13、14 章） |
| KMS 管理员滥用权限 | 云平台 KMS 访问审计、密钥策略审批流程 |
| 快照/备份被有权限的管理员恢复并读取 | 审计日志、访问控制、备份加密 |

### 取舍

1. **每员工一个独立 Namespace**：管理开销增加，但可通过 Controller 自动化。隔离的强度一旦做弱就很难事后补救。
2. **一个加密 Volume 而非多个**：减少存储管理复杂度，加密覆盖全部持久化数据。
3. **Deployment vs 直接创建 Pod**：选择了 Deployment，牺牲少量控制粒度，换取自动重启和更新能力。
4. **标准容器 vs gVisor vs Kata**：默认使用标准容器 + 纵深防御，不可信 Shell 场景升级到 gVisor 或 Kata。
5. **只读根文件系统**：增加运维复杂度，但大幅减少攻击面。
6. **加密存储**：少量 I/O 延迟（通常 < 5%），防止存储后端被入侵时的数据泄露。
7. **共享 KEK vs 每员工独立 KMS 密钥**：EBS 已为每个卷生成独立 DEK，共享 KEK 管理简单。合规要求严格时使用独立密钥。
8. **PVC reclaimPolicy: Delete**：简化离职数据清理，但删除后无法恢复。需要恢复能力应先做快照。

## 本章小结

本章完成了为每位员工构建隔离 Agent Sandbox 的设计：

1. **核心原则**：One Person, One Namespace, One Pod, One Encrypted Volume。
2. **Namespace 隔离**：Kubernetes RBAC 天然按 Namespace 隔离，NetworkPolicy 作用域清晰。
3. **纵深防御**：非 root、只读根文件系统、移除所有 capabilities、Seccomp、资源限制。
4. **加密持久化存储**：每个员工一个独立的加密 PVC，使用存储后端提供的透明静态加密，由 KMS 管理密钥。
5. **透明加密的保护边界**：加密保护落盘数据，不替代运行时访问控制。通过 subPath 在同一 PVC 下区分工作目录和 Memory。
6. **最小权限身份**：`automountServiceAccountToken: false`。
7. **生命周期管理**：创建、暂停、回收、备份、恢复的完整流程。回收时按数据保留策略处理 PVC。
8. **密钥轮换**：KMS 密钥定期轮换，EBS 卷的 DEK 不受自动轮换影响。
9. **更强隔离**：当标准容器不够时，使用 gVisor 或 Kata Containers。

Sandbox 解决了计算和存储隔离的问题。但 Agent 仍然可能通过网络访问未授权的目标，或向 Tool Gateway 发起恶意工具调用——这分别由第 6 章（网络策略）和第 7 章（Tool Gateway 授权）解决。

## 参考资料

- Kubernetes Pod 安全标准：https://kubernetes.io/docs/concepts/security/pod-security-standards/
- Kubernetes Security Context：https://kubernetes.io/docs/tasks/configure-pod-container/security-context/
- Linux Capabilities 详解：https://man7.org/linux/man-pages/man7/capabilities.7.html
- Seccomp 配置文件：https://kubernetes.io/docs/tutorials/security/seccomp/
- gVisor 文档：https://gvisor.dev/docs/
- Kata Containers 文档：https://katacontainers.io/docs/
- Kubernetes ResourceQuota：https://kubernetes.io/docs/concepts/policy/resource-quotas/
- Kubernetes LimitRange：https://kubernetes.io/docs/concepts/policy/limit-range/
- AWS EBS 加密：https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EBSEncryption.html
- AWS EBS CSI Driver：https://docs.aws.amazon.com/zh_cn/eks/latest/userguide/ebs-csi.html
- AWS KMS 密钥轮换：https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html
- Kubernetes CSI VolumeSnapshot：https://kubernetes.io/docs/concepts/storage/volume-snapshots/
- 参考案例：Razorpay Hermes 部署的网络隔离与 Sandbox 实践 https://engineering.razorpay.com/running-hermes-at-razorpay-a-network-isolated-self-improving-second-brain-for-every-employee-f91d56bea3f1
