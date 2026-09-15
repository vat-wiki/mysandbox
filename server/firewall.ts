// 宿主防火墙（ufw）期望规则的计算。三方互通（宿主 ↔ LXC 容器 ↔ docker 服务）是项目基础，
// 其中「容器访问宿主服务」（ufw INPUT）与「LXC 桥的路由放行」没有常驻守护者——漏一条就是
// 「容器里访问不到服务」，SYN 静默被丢，极难排查（2026-09-03 的 7321 事故）。
//
// 信任模型（2026-09-15 起，替代旧逐端口白名单）：**自管网段 = 完全可信的开发工作区**
// （mysandbox 是开发机工具，不做面向部署的隔离），LXC 网段与 services 网段各推一条
// 全端口 blanket——DNS 53、dockerApi 2375、peer 7331、console 7321、宿主其余自有监听
// （xrdp、开发端口…）都 ride 在其上，dockerApi/peer/listen 的开关只决定有没有监听，
// 不决定防火墙。逐端口白名单的实测教训：docker-proxy 发布的容器端口走 DNAT→FORWARD
// 不经 INPUT，宿主自有端口才被 ufw INPUT 拦——同一容器「有的端口通有的不通」极难排查
// （testlens：发布端口 8788 通、自有端口 3389 不通），blanket 一刀切消掉这类半通状态。
// 需要隔离的只剩**外部网段**（热点/局域网设备），走 config.firewall.allow 逐端口放行
// （缺 port = 全端口）。
//
// 职责分界：
//   这里只「算」：纯读 config 推导期望规则，无需 root、不碰系统（`mysandbox firewall print`）。
//   「应用」在 scripts/mysandbox-firewall.sh（root，scripts/mysandbox-firewall.service 开机跑；
//   config 相关配置变更后手工 restart）。应用侧幂等（已在 ufw status 里就跳过）、只增不删
//   （手敲的历史规则不会被回收；要清理手工 ufw delete）。
//
// 转发层（FORWARD）的分工——本模块只管 LXC 桥这一条 route 放行，其余各有归属：
//   - LXC 网段出网 MASQUERADE：mysandbox-net.service（nat 表，ufw 之前）。
//   - LXC → docker 跨桥：mysandbox-docker-interop.service（raw 表 + DOCKER-USER，ufw 之前）。
//   - docker 服务网段出网：docker 自己往 FORWARD 前端插的 `! -o <桥> ACCEPT`，无需重复。
import type { Config } from './config.js';

export interface FirewallRule {
  kind: 'input' | 'route';
  // input: '<port>/<proto>' 或 'any'（全端口）；route: 桥设备名
  spec: string;
  // input: 来源网段（CIDR）
  from?: string;
  comment: string;
}

// ipPool.from → /24 网段（前缀取前 3 段，与 gatewayOf 的约定一致）。不是点分 IPv4 返回 null。
function subnetOf(poolFrom: string): string | null {
  const m = poolFrom.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? `${m[1]}.0/24` : null;
}

export function desiredFirewallRules(config: Config): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const lxcSubnet = subnetOf(config.ipPool.from);

  // 自管网段 = 可信工作区：INPUT 全端口 blanket。注意 docker-proxy 发布的容器端口走
  // DNAT→FORWARD 不经 INPUT——这条只决定「宿主自有端口」的可达性，与发布端口路径互不相干。
  if (lxcSubnet) {
    rules.push({
      kind: 'input',
      spec: 'any',
      from: lxcSubnet,
      comment: 'mysandbox: LXC work net fully trusted (all ports -> host)',
    });
  }
  if (config.services.enabled) {
    const svcSubnet = subnetOf(config.services.ipPool.from);
    if (svcSubnet) {
      rules.push({
        kind: 'input',
        spec: 'any',
        from: svcSubnet,
        comment: 'mysandbox: services net fully trusted (all ports -> host)',
      });
    }
  }

  // LXC 桥的路由放行（等价于旧 /etc/ufw/before.rules 里手改的 -A ufw-before-forward -i <桥>
  // ACCEPT，那条保留无害；这条走 ufw 自管，可见、可查、随 config 走）。
  rules.push({
    kind: 'route',
    spec: config.network,
    comment: 'mysandbox: routed accept from LXC bridge',
  });

  // 外部网段特例（config firewall.allow）：热点访问 console 等。自管网段不需要条目
  // （上面 blanket 已全覆盖），这里只服务真正的外部来源；port 缺省 = 全端口。
  for (const r of config.firewall.allow) {
    const comment = r.comment || `mysandbox: allow ${r.from}${r.port ? ` -> ${r.port}` : ''}`;
    if (r.port == null) {
      rules.push({ kind: 'input', spec: 'any', from: r.from, comment });
    } else {
      rules.push({ kind: 'input', spec: `${r.port}/${r.proto ?? 'tcp'}`, from: r.from, comment });
    }
  }

  return rules;
}

// 一次性子命令：mysandbox firewall print（不启动 server、不需要 root）。
// 输出 tab 分隔行，由 scripts/mysandbox-firewall.sh 消费：
//   input\t<port/proto|any>\t<来源网段>\t<comment>
//   route\t<桥设备名>\t<comment>
export async function runFirewallCommand(argv: string[], config: Config): Promise<void> {
  const sub = argv[0] || 'print';
  if (sub !== 'print') {
    process.stderr.write(`>> mysandbox firewall: 未知子命令 '${sub}'（支持: print）\n`);
    process.exit(1);
  }
  for (const r of desiredFirewallRules(config)) {
    if (r.kind === 'route') {
      process.stdout.write(`route\t${r.spec}\t${r.comment}\n`);
    } else {
      process.stdout.write(`input\t${r.spec}\t${r.from}\t${r.comment}\n`);
    }
  }
}
