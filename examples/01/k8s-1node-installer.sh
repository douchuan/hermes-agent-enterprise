#!/bin/bash

set -e

echo "*** A. Installing Kubernetes Single-Node Setup on Ubuntu 24.04 ***"

clear

echo " === A-1. Prepare the Ubuntu VM/BM ==="
echo "        - Update system packages:"
sudo apt update && sudo apt upgrade -y

echo "        - Disable swap (Kubernetes requires this):"
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab

echo " === A-2. Enable Kernel Modules and Sysctl Settings:"
sudo modprobe overlay
sudo modprobe br_netfilter

sudo tee /etc/sysctl.d/kubernetes.conf <<EOF
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF

sudo sysctl --system

echo " === A-3. Install Docker or Containerd (Container Runtime) ==="
#    - Docker(not is my-case!!!)
# sudo apt install -y docker.io
# sudo systemctl enable docker
# sudo systemctl start docker

# or Install 

echo "        - Containerd(that is my-case!!!):"
#      see also and 
#               https://containerd.io/
sudo apt install -y containerd

sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml

echo "          Enable systemd cgroup"
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

echo "          Change the default pause image to a mirror image"
sudo sed -i 's|registry.k8s.io/pause:3.10|registry.aliyuncs.com/google_containers/pause:3.10|' /etc/containerd/config.toml

sudo systemctl restart containerd
sudo systemctl enable containerd

echo " === A-4. Add the Kubernetes APT Repository:"
sudo apt install -y apt-transport-https ca-certificates curl gpg

sudo mkdir -p /etc/apt/keyrings

curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.33/deb/Release.key | \
sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] \
https://pkgs.k8s.io/core:/stable:/v1.33/deb/ /" | \
sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt update

echo " === A-5. Install Kubernetes Tools - kubeadm, kubelet, kubectl:"
sudo apt-mark unhold kubelet kubeadm kubectl
sudo apt update
sudo apt install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

echo " === A-6. Install Helm ==="
#    - with single-line L(not is my case!!!)
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# or

# NOTE: helm-v3.17.3-linux-amd64.tar.gz is not proper for ARM64 architecture
# echo "        - with multiple lines(that is my case!!!):"
# curl -LO https://get.helm.sh/helm-v3.17.3-linux-amd64.tar.gz
# tar -zxvf helm-v3.17.3-linux-amd64.tar.gz
# sudo mv linux-amd64/helm /usr/local/bin/helm
# rm -rf helm-v3.17.3-linux-amd64.tar.gz

which helm
whereis helm
helm version

#helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
#helm repo update
helm repo add prometheus-community https://helm-charts.itboon.top/prometheus-community
helm repo update prometheus-community

echo " === A-7. Initialize the Kubernetes Control Plane:"
#sudo kubeadm init --pod-network-cidr=10.0.0.0/16
sudo kubeadm init --image-repository=registry.aliyuncs.com/google_containers --pod-network-cidr=10.0.0.0/16

echo " === A-8. Set up kubeconfig:"
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

echo " === A-9. Check Node Status:"
kubectl get nodes
echo "    Output: is-kube shows as NotReady" 
echo "            (because Pod Network is not yet installed)"

echo "------------------------------------------------------------------------"

echo " --- B. Install Cilium CNI ---"
# In K8s + containerd + Cilium configuration,
# the Cilium provides isolation and networking that once required separate VMs
# Conclusion: In this config, no need VMs for separation... could be simple BM/bare-metal,
#             because the separation is already ensured by the given configuration itself
# see also and
#          https://docs.cilium.io/en/stable/gettingstarted/k8s-install-default/

echo " === B-1. Install cilium-cli:"
#curl -L --remote-name https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
#sudo tar xzvf cilium-linux-amd64.tar.gz -C /usr/local/bin
#rm cilium-linux-amd64.tar.gz

# 下载 arm64 版 cilium-cli
#curl -L --remote-name https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-arm64.tar.gz
#sudo tar xzvf cilium-linux-arm64.tar.gz -C /usr/local/bin
#rm cilium-linux-arm64.tar.gz

# 检测架构并映射
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)      CILIUM_ARCH="amd64" ;;
  aarch64|arm64)     CILIUM_ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac
echo "检测到架构: $ARCH -> 使用 cilium-linux-${CILIUM_ARCH}"
curl -L --remote-name "https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-${CILIUM_ARCH}.tar.gz"
sudo tar xzvf "cilium-linux-${CILIUM_ARCH}.tar.gz" -C /usr/local/bin
rm "cilium-linux-${CILIUM_ARCH}.tar.gz"

echo " === B-2. Install Cilium:"
cilium install

echo " === B-3. Check Node Status and Cilium Status:"
kubectl get nodes
cilium status

#
# debug
#
# kubeadm init 阶段:
# sudo systemctl status kubelet --no-pager -l
# sudo systemctl status containerd --no-pager -l
# sudo journalctl -u kubelet -n 100 --no-pager

#  看 pod 状态、重启次数、OOM 标记
# kubectl -n kube-system get pods -o wide
# 看 cilium-agent 最近日志
# kubectl -n kube-system logs -l k8s-app=cilium --tail=200
# 看 agent 的完整描述（含事件、是否 OOMKilled）
# kubectl -n kube-system describe pod -l k8s-app=cilium