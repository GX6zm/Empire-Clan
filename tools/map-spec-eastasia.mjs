/**
 * map-spec-eastasia.mjs —— 「神州复兴」模组的东亚地图
 *
 * 只写两样东西：海岸线、省会种子点。
 * 省界由 tools/build-map.mjs 用 Voronoi 算出来，邻接关系也是算出来的。
 *
 * 坐标约定：viewBox 1000×700，经度 90°E→150°E 映射到 x 50→950，
 * 纬度 55°N→10°N 映射到 y 80→640（北在上）。
 * 这不是等距投影，只是让形状看起来对——抽象战略图，不需要能量距离。
 */

export default {
  id: 'eastasia',
  viewBox: [0, 0, 1000, 700],
  out: 'data/mods/celestial-revival/map.json',

  /* ---------- 陆地 ---------- */

  land: [
    // 亚洲大陆：西伯利亚 → 鄂霍次克海 → 朝鲜半岛 → 中国海岸 → 印度支那 → 孟加拉湾
    [
      [0, 0], [1000, 0], [1000, 70],
      [940, 84], [892, 112], [860, 146], [830, 172], [800, 192], [770, 208],
      [742, 220], [714, 234], [696, 250],
      // 朝鲜半岛东岸南下
      [680, 270], [668, 294], [658, 316], [646, 336],
      // 半岛南端
      [628, 344], [610, 334],
      // 西岸北上
      [602, 314], [596, 294], [592, 274], [600, 257],
      // 黄海 / 渤海
      [584, 248], [562, 242], [540, 247], [522, 257],
      [520, 272], [530, 286], [520, 302],
      // 长江口以南
      [512, 322], [520, 344], [526, 366], [516, 388], [502, 408], [486, 428],
      [470, 446], [452, 462], [432, 476],
      // 华南
      [410, 488], [390, 496], [370, 500], [352, 496], [336, 504],
      // 中南半岛东岸（越南这一段必须贴着 x≈300-330，否则西贡会掉进海里）
      [330, 520], [325, 540], [322, 560], [325, 580], [330, 600], [332, 618], [326, 634],
      // 湄公河口 → 泰国湾
      [300, 646], [270, 650], [240, 646], [212, 638],
      // 马来半岛
      [196, 652], [180, 668], [160, 684], [142, 700],
      // 图上沿收边（孟加拉湾以西是画外，留一块陆地边）
      [40, 700], [0, 690], [0, 522],
    ],

    // 本州：先东西向再折向北，别画成一根斜线
    [
      [662, 348], [700, 340], [740, 332], [775, 326], [800, 322], [815, 320],
      [818, 308], [808, 290], [800, 272], [812, 256], [824, 244],
      [806, 250], [782, 262], [754, 274], [726, 286], [700, 298], [676, 308],
      [660, 320], [658, 336],
    ],
    // 九州
    [[644, 352], [666, 344], [676, 362], [668, 382], [648, 386], [638, 368]],
    // 四国
    [[692, 340], [714, 334], [720, 348], [700, 356], [688, 352]],
    // 北海道
    [[820, 232], [848, 214], [872, 208], [878, 226], [854, 240], [828, 244]],
    // 台湾
    [[502, 462], [522, 452], [532, 470], [520, 488], [504, 482]],
    // 海南
    [[332, 520], [352, 512], [360, 526], [340, 536]],
  ],

  /* ---------- 省份 ---------- */

  seeds: [
    /* 中华民国 */
    { id: 'beiping', name: '北平', owner: 'CHN', vp: 10, at: [446, 268] },
    { id: 'shandong', name: '山东', owner: 'CHN', vp: 5, at: [455, 309] },
    { id: 'shanxi', name: '山西', owner: 'CHN', vp: 4, at: [388, 298] },
    { id: 'shaanxi', name: '陕西', owner: 'CHN', vp: 5, at: [334, 338] },
    { id: 'gansu', name: '甘肃', owner: 'CHN', vp: 3, at: [257, 316] },
    { id: 'henan', name: '河南', owner: 'CHN', vp: 6, at: [404, 332] },
    { id: 'jiangsu', name: '江苏', owner: 'CHN', vp: 6, at: [482, 365] },
    { id: 'anhui', name: '安徽', owner: 'CHN', vp: 4, at: [460, 369] },
    { id: 'zhejiang', name: '浙江', owner: 'CHN', vp: 5, at: [503, 401] },
    { id: 'jiangxi', name: '江西', owner: 'CHN', vp: 4, at: [439, 407] },
    { id: 'hubei', name: '湖北', owner: 'CHN', vp: 5, at: [415, 384] },
    { id: 'hunan', name: '湖南', owner: 'CHN', vp: 4, at: [394, 414] },
    { id: 'sichuan', name: '四川', owner: 'CHN', vp: 6, at: [262, 382] },
    { id: 'yunnan', name: '云南', owner: 'CHN', vp: 4, at: [241, 453] },
    { id: 'guangxi', name: '广西', owner: 'CHN', vp: 3, at: [332, 468] },
    { id: 'guangdong', name: '广东', owner: 'CHN', vp: 6, at: [400, 477] },
    { id: 'fujian', name: '福建', owner: 'CHN', vp: 4, at: [475, 440] },
    { id: 'liaoning', name: '辽宁', owner: 'CHN', vp: 5, at: [551, 244] },
    { id: 'jilin', name: '吉林', owner: 'CHN', vp: 4, at: [598, 219] },
    { id: 'heilongjiang', name: '黑龙江', owner: 'CHN', vp: 4, at: [605, 180] },
    { id: 'chahar', name: '察哈尔', owner: 'CHN', vp: 3, at: [410, 242] },
    { id: 'qinghai', name: '青海', owner: 'CHN', vp: 2, at: [227, 309] },
    { id: 'tibet', name: '西藏', owner: 'CHN', vp: 3, at: [67, 396] },
    { id: 'xinjiang', name: '新疆', owner: 'CHN', vp: 3, at: [80, 242] },
    { id: 'hainan', name: '海南', owner: 'CHN', vp: 2, at: [345, 524] },

    /* 苏维埃联盟 */
    { id: 'menggu', name: '蒙古', owner: 'SOV', vp: 4, at: [290, 180] },
    { id: 'xiboliya', name: '西伯利亚', owner: 'SOV', vp: 3, at: [350, 92] },
    { id: 'waibeijiaer', name: '外贝加尔', owner: 'SOV', vp: 3, at: [425, 130] },
    { id: 'yuandong', name: '远东', owner: 'SOV', vp: 5, at: [725, 167] },
    { id: 'binhai', name: '滨海', owner: 'SOV', vp: 4, at: [680, 223] },

    /* 大日本帝国 */
    { id: 'chaoxian', name: '朝鲜', owner: 'JPN', vp: 6, at: [613, 285] },
    { id: 'jiuzhou', name: '九州', owner: 'JPN', vp: 5, at: [658, 366] },
    { id: 'sihuo', name: '四国', owner: 'JPN', vp: 2, at: [704, 346] },
    { id: 'jinei', name: '畿内', owner: 'JPN', vp: 5, at: [730, 318] },
    { id: 'guandong', name: '关东', owner: 'JPN', vp: 8, at: [790, 300] },
    { id: 'aoyu', name: '奥羽', owner: 'JPN', vp: 4, at: [800, 272] },
    { id: 'beihaidao', name: '北海道', owner: 'JPN', vp: 3, at: [848, 226] },
    { id: 'taiwan', name: '台湾', owner: 'JPN', vp: 5, at: [515, 470] },

    /* 法属印度支那 */
    { id: 'henei', name: '河内', owner: 'FRA', vp: 3, at: [287, 503] },
    { id: 'laowo', name: '老挝', owner: 'FRA', vp: 2, at: [238, 522] },
    { id: 'jianpuzhai', name: '柬埔寨', owner: 'FRA', vp: 2, at: [274, 609] },
    { id: 'xigong', name: '西贡', owner: 'FRA', vp: 3, at: [301, 630] },
  ],

  /* 海峡两岸靠几何推不出来，得手动接上 */
  extraAdjacency: [
    ['chaoxian', 'jiuzhou'],
    ['jiuzhou', 'sihuo'],
    ['jiuzhou', 'jinei'],
    ['sihuo', 'jinei'],
    ['taiwan', 'fujian'],
    ['hainan', 'guangdong'],
  ],
};
