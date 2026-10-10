
## 准备环境

- VirtualBox + ubuntu
- 部署 k8s

## 配置 virtualbox

VirtualBox 7.2.20 r175154 + ubuntu-24.04.5-live-server

```bash
# 免密登录
ssh -i /Users/<username>/.ssh/id_ed25519_vboxuser -p 2225 'vboxuser@127.0.0.1'

# 编辑 ~/.ssh/config 添加:
#
# Host hermes-enterprise1
#   HostName 127.0.0.1
#   Port 2225
#   User vboxuser
#   IdentityFile ~/.ssh/id_ed25519_vboxuser
#   IdentitiesOnly yes
vim ~/.ssh/config

# 登录
ssh hermes-enterprise1

# 重置系统id
sudo hostnamectl set-hostname hermes-enterprise1

sudo truncate -s 0 /etc/machine-id
sudo systemd-machine-id-setup
```

## 部署 k8s

ref: [k8s-1node-installer.sh](k8s-1node-installer.sh)

> https://medium.com/@ion.stefanache0/ops-install-k8s-single-node-containerd-based-setup-under-ubuntu-24-04-40eb45941c35

