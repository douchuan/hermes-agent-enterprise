# 第 4 章：企业身份认证与授权

> 状态：待撰写

## 本章目标

实现可靠的员工登录，并将用户身份安全地关联到 Agent 和企业资源访问权限。

## 建议内容

- Google OIDC 登录流程
- Authorization Code Flow 与 PKCE
- 服务端 Session、HttpOnly Cookie 与会话生命周期
- ID Token 验证：签名、Issuer、Audience、Nonce 和过期时间
- 员工身份、Agent 身份、工作负载身份的区别
- 多租户身份映射与对象级授权
- 为什么不能仅凭邮箱地址确定稳定身份
- 员工离职、账号禁用与会话撤销

## 本章产出

- 登录时序图
- 身份与授权数据模型
- 授权检查流程
- 身份相关安全测试用例
