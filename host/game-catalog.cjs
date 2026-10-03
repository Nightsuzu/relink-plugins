// Deliberately small, auditable list of game executables (not launchers).
const games = Object.freeze({
  "deltaforceclient-win64-shipping.exe": "三角洲行动",
  "deltaforce.exe": "三角洲行动",
  "genshinimpact.exe": "原神",
  "yuanshen.exe": "原神",
  "starrail.exe": "崩坏：星穹铁道",
  "valorant-win64-shipping.exe": "无畏契约",
  "cs2.exe": "Counter-Strike 2",
  "tslgame.exe": "绝地求生",
  "overwatch.exe": "守望先锋",
  "eldenring.exe": "艾尔登法环",
  "cyberpunk2077.exe": "赛博朋克 2077",
  "league of legends.exe": "英雄联盟",
  "forzahorizon6.exe": "极限竞速：地平线 6",
  "forzahorizon5.exe": "极限竞速：地平线 5",
  "blackmythwukong.exe": "黑神话：悟空",
  "b1-win64-shipping.exe": "黑神话：悟空",
  "aces.exe": "战争雷霆",
  "r5apex.exe": "Apex Legends",
  "fortniteclient-win64-shipping.exe": "Fortnite",
  "destiny2.exe": "Destiny 2",
});
const blocked =
  /^(?:relink.*|codex|explorer|dwm|msedge|chrome|firefox|brave|opera|qqmusic|cloudmusic|spotify|soda|steam|steamwebhelper|wechat|weixin|qq|applicationframehost|systemsettings|searchhost)\.exe$/i;
function candidates(rows) {
  return Array.isArray(rows)
    ? rows
        .slice(0, 64)
        .filter(
          (r) =>
            r &&
            Number.isInteger(r.pid) &&
            r.pid > 0 &&
            typeof r.created === "string" &&
            /^\d{1,20}$/.test(r.created) &&
            typeof r.exe === "string" &&
            r.exe.length < 160 &&
            !/[\\/\x00-\x1f]/.test(r.exe) &&
            r.exe.endsWith(".exe") &&
            !blocked.test(r.exe),
        )
        .map((r) => ({
          ...r,
          exe: r.exe.toLowerCase(),
          name: games[r.exe.toLowerCase()] || r.exe,
          known: Boolean(games[r.exe.toLowerCase()]),
          foreground: r.foreground === true,
        }))
    : [];
}
module.exports = { games, candidates };
