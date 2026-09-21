# vendor/wireguard —— 随安装器分发的 WireGuard for Windows 官方 MSI

## 这个目录为什么存在

Windows 侧的集群隧道依赖 WireGuard。Linux 上我们靠内核模块 + `wireguard-tools`，
Windows 上不行——**Windows 版 WireGuard 的内核驱动必须由 Microsoft 签名才能被系统加载**，
所以「用户完全不用装」在 Windows 上做不到，只能做到「用户完全看不见」。

做法（方案 A）：把官方 MSI 打进我们的安装包，由安装器静默装一次，用户无感。
本目录就是那个包的落点。

## 当前锁定版本

| 项 | 值 |
|---|---|
| 文件 | `wireguard-amd64-1.1.1.msi` |
| 上游 | <https://download.wireguard.com/windows-client/> |
| 版本 | 1.1.1（amd64） |
| 大小 | 3,293,184 字节 |
| sha256 | `7bfed60ad61b785c914b38b61555a975488e1d3ec472dbfb2fcdf498fca75242` |

上游同一版本另有 `wireguard-arm64-1.1.1.msi` 与 `wireguard-x86-1.1.1.msi`。
要一并带上，见下面「更新 / 补架构」。

## 安装（静默）

需管理员权限（UAC 一次，Windows 安装应用 / HKLM 都要写）：

```bat
msiexec /i "<路径>\wireguard-amd64-1.1.1.msi" /qn /norestart
```

约 3 MB、10–15 秒、**无需重启**。

### ⚠️ 主安装器不能是 MSI

**MSI 里套 MSI 会把安装搞坏**（Netmaker 踩过这个坑，他们的 MSI 内嵌 WireGuard MSI
后安装直接失败）。所以我们的主安装器必须是 **EXE bundle**（WiX Burn 那一类，由它依次
拉起两个 MSI），或者在非 MSI 的安装器里用 `msiexec` 单独调一次。

## 装完之后，运行期能拿到什么

安装目录 `C:\Program Files\WireGuard\`：

- `wireguard.exe` —— 隧道服务管理器
- `wg.exe` —— 密钥与状态查询（**不在 PATH**，`server/wireguard.ts` 里拼的绝对路径就是它）

**没有 `wg-quick`。** 隧道靠 `wireguard.exe` 注册成 Windows 服务来承载：

```bat
wireguard.exe /installtunnelservice   "<conf 路径>"   :: 装/更新隧道（同名幂等）
wireguard.exe /uninstalltunnelservice mysandbox-wg0   :: 卸隧道
```

这两条也正是 `server/wireguard.ts` 的 `wgUp()` / `wgDown()` 在 win32 分支里做的事——
**所以本目录的包装好之后，Windows 侧的业务代码一行都不用改。**
（`wireguard.exe` 注册隧道同样要管理员一次；`scripts/win/mysandbox.ps1` 的计划任务以
RunLevel Highest 运行，进程内直接成功、无 UAC。）

## 许可

- `wireguard-windows`（客户端本体）是 **MIT**——不是 GPLv2。可自由修改、再分发、集成。
  实际上如果将来想把 WireGuard 的牌子从产品里彻底抹掉，可以基于 MIT 源码自编一个裁掉
  UI/托盘的 `wireguard.exe`，不必让用户看到第三方软件。本目录按「原样分发」处理即可。
- 驱动（WireGuardNT，早期版本是 WinTun）**必须带 Microsoft 签名**——这是「必须安装一次」
  的根本原因，也是本目录存在的理由。
- 分发时保留本目录的 `README.md` 与官方 MSI 原样未修改。

## 完整性校验

上游**没有**发布 `.sha256` 旁文件（实测 404），所以校验靠两件事：

1. `SHA256SUMS` —— 本目录内记录，防搬运出错
2. **Authenticode 签名** —— 真正验来源的那道

```powershell
Get-AuthenticodeSignature .\wireguard-amd64-1.1.1.msi | Format-List Status, SignerCertificate
# Status 应为 Valid，签名者应为 WireGuard LLC（Jason A. Donenfeld 的代码签名证书）
```

## 更新 / 补架构

版本或架构要改，不要手工 wget，改 `fetch.sh` 的参数重跑（它会重算 `SHA256SUMS`）：

```bash
./fetch.sh 1.1.1                          # 只 amd64（默认）
ARCHES="amd64 arm64" ./fetch.sh 1.1.1     # 顺带带上 arm64
```

### 国内网络注意

`download.wireguard.com` 在本机**直连不通**（DNS 被污染，解析到 Facebook 段，
直连 000）。走代理即可：

```bash
WG_FETCH_PROXY=http://10.12.135.150:7897 ./fetch.sh 1.1.1
```

CI 上如果也拿不到，同样需要出口代理或提前把 MSI 放进构建缓存。
