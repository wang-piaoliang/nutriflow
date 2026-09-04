import { getChatGPTUser } from "../../../chatgpt-auth";

// 网页靠这个判断"这台设备到底要不要走账号制同步"：
// 有人登录 -> 走 /api/sync，零配置；没有 -> 退回原来那套填口令的 Worker 同步。
// 部署在 GitHub Pages 上时这个接口根本不存在（fetch 直接失败），照样退回去。
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ signedIn: false }, { status: 200 });
  return Response.json({ signedIn: true, email: user.email, name: user.displayName });
}
