/**
 * 零依赖 汉字→拼音（只面向「中文姓名」这一个场景）
 *
 * 背景：makeSlug 原来把中文整段丢掉、退化成 `w-tfrx9` 这种短码，
 * 但产品对用户的承诺是「专属网址」，一串乱码根本没法念、没法发朋友圈。
 * Worker 里又不能装 npm 包（pinyin / pinyin-pro 都是几百 KB 起步、还带 Node API），
 * 所以自己内置一张只覆盖姓名高频字的小表。
 *
 * 为什么不是全量字表：
 *   全量 GB2312 有 6763 字，展开成 Map 光字符串就 40KB+；
 *   而姓名的字分布极度集中 —— 百家姓 + 人名常用字约 1000 字就能覆盖 99% 的真人姓名。
 *   覆盖不到的字返回空串，由调用方（makeSlug）用哈希短码兜底，不会产出乱码。
 *
 * 为什么用「反向紧凑串」而不是 {'张':'zhang'} 对象字面量：
 *   正向写法每个字都要重复一遍拼音 + 引号 + 冒号 + 逗号，约 12 字节/字；
 *   反向写法一个音节只写一次，同音字直接拼在后面，约 2 字节/字。
 *   1000 字下大概是 12KB vs 3KB，gzip 后差距更明显（源码里没有重复 token 可压）。
 *   代价是模块加载时要展开成 Map —— 一次性 O(n)，Worker 冷启动可忽略。
 *
 * 多音字策略：**姓氏优先**。
 *   这个模块是给 creator（姓名）用的，开头第一个字是姓的概率远高于其他读音。
 *   所以「单」读 shan 不读 dan、「解」读 xie 不读 jie，下面表里逐个标了注释。
 *   代价是「单独」会转成 shandu —— 但那不是人名，不在本模块的目标范围内。
 */

/**
 * 紧凑映射表：`音节:同音字...`，空白分隔。
 * 同一个字只允许出现在一个音节里（重复的话以先出现的为准）；
 * scripts/verify-pinyin.mjs 里有查重断言，改表时会被卡住。
 */
export const PINYIN_TABLE = `
a:阿啊 ai:艾爱哀蔼霭埃挨隘碍 an:安按案氨谙鞍岸暗 ang:昂 ao:敖奥澳傲熬翱鳌凹
ba:八巴芭霸把爸拔跋坝 bai:白百柏摆佰败拜 ban:班半般斑板伴办颁 bang:邦帮榜膀
bao:包宝保鲍豹抱堡葆褒暴报 bei:北贝备背倍蓓碑悲卑辈 ben:本奔
bi:毕碧必壁璧彼笔陛弼币闭避比鄙秘 bian:边卞变便扁鞭辨辩
biao:标彪飙表镖 bie:别 bin:宾彬斌滨缤 bing:冰兵丙秉炳并柄饼病
bo:波博伯勃搏渤薄泊铂帛驳播 bu:卜步不布补部簿
cai:蔡才材财彩菜采 can:灿参璨残 cang:苍仓 cao:曹操草 ce:策册 cen:岑
chai:柴钗 chan:婵禅蝉产 chang:常长昌畅厂场倡尝偿嫦
chao:超朝潮巢炒 che:车彻 chen:陈晨辰臣尘沉宸忱谌郴衬
cheng:程成城诚承丞澄呈乘惩橙骋秤 chi:池迟驰赤尺持痴齿
chong:崇冲充重种 chou:抽筹酬丑愁 chu:楚初储触除处出础厨
chuan:川传船穿串喘 chuang:创窗床闯 chui:垂吹锤 chun:春纯淳醇椿
ci:慈磁词次辞刺瓷 cong:从聪丛琮 cui:崔翠催粹璀 cun:存村寸 cuo:错措
da:大达打答 dai:戴代待带贷黛岱 dan:丹旦但淡担胆蛋 dang:党当挡
dao:道刀导岛倒到 de:德得 deng:邓登灯等 di:狄迪帝地底笛荻嫡涤敌第
dian:典点电殿甸 diao:刁雕吊调 die:蝶叠迭 ding:丁顶定订鼎钉
dong:董东冬懂动栋洞 dou:窦豆斗兜 du:杜独度渡都督毒读笃睹
duan:段断端锻 dui:对队 dun:敦盾顿 duo:多朵铎夺
e:鄂厄娥额俄恶 en:恩 er:尔儿二耳
fa:法发伐罚 fan:范樊凡帆反饭泛翻烦 fang:方房芳防访放纺舫仿妨
fei:费飞菲绯霏斐非肥废 fen:芬分粉纷汾奋愤
feng:冯风峰锋丰枫封凤逢奉讽疯烽 fu:傅付福富符复夫扶父府副妇伏浮辅甫芙馥抚服负腐
gai:盖改 gan:甘干敢赣感 gang:冈刚钢岗纲港 gao:高告膏皋郜稿搞
ge:葛戈哥格革歌阁个各割 gen:根跟 geng:耿更庚耕
gong:龚公工弓宫功共巩恭贡供 gou:苟勾沟够 gu:顾古谷股鼓固故骨姑辜孤估
guan:关官管冠观贯馆惯 guang:光广逛 gui:桂贵归圭规轨鬼癸瑰柜
guo:郭国果过锅裹
ha:哈 hai:海亥孩害 han:韩汉寒含涵函翰晗菡邯憨罕喊汗 hang:杭航
hao:郝好浩豪皓昊颢号毫 he:何贺和河合荷赫鹤核禾褐喝 hei:黑 heng:恒衡横亨
hong:洪宏红鸿虹弘泓 hou:侯厚后候猴 hu:胡湖虎户护沪壶琥呼忽狐糊
hua:华花画化划桦骅 huai:怀淮槐坏 huan:桓欢环还换焕寰缓幻
huang:黄皇煌凰璜潢惶 hui:惠慧辉徽回汇卉会绘挥灰 huo:霍火货活伙或获
ji:纪季吉计极集己继基机及即急激级籍稽姬绩嵇冀汲佶骥济寄记技际
jia:贾家佳嘉加甲夹价驾稼架假 jian:简健建剑坚检见间兼渐鉴键荐柬减
jiang:姜江蒋讲奖降疆僵酱 jiao:焦交教娇骄角矫皎叫较脚
jie:杰节洁介结界街届捷阶戒姐借睫接皆 jin:金今近进晋津锦谨劲禁尽仅紧
jing:京经晶精景敬静净境竟井警径靖婧鲸兢竞镜 jiong:炯迥 jiu:九久酒旧就纠救
ju:居鞠句巨具剧据菊举距聚矩拒 juan:娟卷绢隽 jue:觉决爵绝
jun:军君俊均峻骏郡菌钧筠
ka:卡 kai:开凯恺楷慨铠 kan:阚看堪坎砍 kang:康抗亢慷 kao:考靠
ke:柯可克科课颗渴壳珂客 ken:肯垦 kong:孔空控恐 kou:寇口扣 ku:库苦哭裤
kuai:蒯快块 kuan:宽 kuang:匡邝况狂旷框矿 kui:奎魁葵揆愧 kun:坤昆鲲捆 kuo:阔扩
la:拉腊辣 lai:来赖莱 lan:兰蓝岚览篮拦懒澜斓烂 lang:郎朗浪廊狼
lao:劳老 le:勒 lei:雷磊蕾累泪垒儡 leng:冷
li:李丽力立利黎理礼励历厉璃莉俐里梨栗隶粒沥漓骊笠郦荔篱吏犁例
lian:连廉练莲联恋怜镰帘脸 liang:梁良亮量粮凉谅辆靓两
liao:廖辽疗料寥 lie:列烈猎裂 lin:林琳霖临淋磷麟吝邻
ling:凌玲铃陵灵零龄岭令伶羚 liu:刘柳留流六琉浏
long:龙隆珑笼胧陇 lou:娄楼漏搂 lu:卢陆鲁路露炉鹿禄璐录芦泸潞卤
lv:吕绿律旅屡侣铝虑 luan:栾峦乱 lue:略 lun:伦轮论 luo:罗骆洛落络萝逻螺珞
ma:马麻码妈玛骂 mai:麦买卖迈脉 man:满曼漫蔓慢瞒 mang:芒忙茫
mao:毛茅茂冒帽貌卯猫贸 mei:梅美媚妹眉媒煤玫镁每 men:门们闷
meng:孟蒙梦盟猛萌檬 mi:米密弥迷谜蜜靡觅 mian:免面绵勉棉
miao:苗缪妙庙描渺淼秒 min:闵敏民闽悯泯珉 ming:明名铭鸣命冥茗
mo:莫墨末默摩磨漠陌沫茉膜魔 mou:牟谋某 mu:穆木目牧母幕慕暮沐睦
na:娜那纳拿 nai:乃奈耐 nan:南男难楠 nao:脑闹恼 nei:内 neng:能
ni:倪尼妮泥你逆霓拟腻 nian:年念廿 niang:娘酿 niao:鸟 nie:聂涅镍
ning:宁凝拧咛 niu:牛纽妞 nong:农浓侬弄 nu:努奴怒 nv:女 nuan:暖 nuo:诺挪懦糯
ou:欧区偶藕讴瓯
pa:帕怕爬 pai:派拍排牌 pan:潘盘攀判叛盼畔 pang:庞旁胖 pao:炮跑抛袍
pei:裴培佩沛配陪赔 peng:彭鹏朋蓬棚膨捧碰 pi:皮批披疲脾匹
pian:篇偏片骗 piao:朴飘漂票瓢 pin:品贫聘频拼 ping:平萍苹凭评瓶屏坪乒
po:繁坡婆破迫魄颇 pu:蒲普浦谱铺葡溥仆扑
qi:齐戚祁七期启奇棋琪其气骑旗欺漆祺岐崎麒淇祈契汽泣起企岂器
qia:恰 qian:钱前千迁签浅谦乾潜黔倩遣欠牵铅 qiang:强抢墙羌蔷枪
qiao:乔桥巧侨樵瞧俏悄峭敲 qie:切且窃 qin:秦琴勤钦亲芹覃沁禽擒寝侵
qing:青清庆卿轻情晴倾请顷氢擎 qiong:琼穷 qiu:邱丘秋仇求球裘囚
qu:曲屈渠瞿趣取娶去驱 quan:全权泉拳劝犬铨券 que:缺却确雀阙 qun:群裙
ran:冉然燃染 rang:让壤 rao:饶绕扰 re:热 ren:任仁人忍认刃韧壬 reng:仍 ri:日
rong:荣容融戎绒溶蓉茸榕 rou:柔肉 ru:茹如儒汝入乳孺 ruan:阮软
rui:芮瑞锐蕊睿 run:润闰 ruo:若弱
sa:萨撒洒 sai:赛塞 san:三散伞 sang:桑丧嗓 sao:扫嫂骚 se:色瑟涩 sen:森
sha:沙纱莎砂杀傻 shan:单山善珊闪扇陕删杉膳擅衫 shang:商尚上伤赏裳
shao:邵召少绍勺烧稍梢 she:佘舍社设涉射蛇赦 shen:沈申深神甚慎审婶伸绅肾身什
sheng:盛胜生升声圣绳剩甥省 shi:石施史时十世事实食师诗士示式视试市失始势拾狮氏仕嗜莳适室
shou:寿受手首守授兽收瘦 shu:舒书淑树殊叔属数术述蜀曙姝墅赎输熟
shuai:帅率摔 shuang:双霜爽 shui:水税谁睡 shun:顺舜瞬 shuo:硕说朔烁
si:司思斯丝私四死似饲寺嗣祀肆 song:宋松送颂诵嵩崧凇耸 sou:搜
su:苏素速宿肃诉塑俗夙粟 suan:算酸 sui:隋随岁穗虽遂碎 sun:孙损笋荪 suo:索所锁缩
ta:塔他她它踏塌 tai:台太泰态钛苔抬 tan:谭谈檀坛探贪滩潭坦炭叹昙弹
tang:唐汤堂棠塘糖躺趟膛 tao:陶涛桃淘讨滔韬套逃 te:特 teng:滕腾藤誊疼
ti:提题体替梯剃踢 tian:田天甜添填恬 tiao:条跳挑 tie:铁贴
ting:廷婷庭亭听停艇挺霆厅 tong:童佟通同铜彤桐统桶痛潼捅
tou:头投透 tu:涂屠图土兔徒途吐凸突 tuan:团 tui:推退腿 tun:屯吞 tuo:拓托脱妥驼拖
wa:娃瓦挖袜 wai:外歪 wan:万完晚碗湾玩婉宛挽腕纨弯
wang:王汪往网忘旺望亡枉 wei:魏韦卫伟维威唯为未位委蔚薇巍围违惟微伪尾味畏纬玮炜喂
wen:温文闻问稳纹雯汶吻 weng:翁 wo:我沃卧握
wu:吴武伍五物无午吾梧悟屋乌污误雾舞巫毋务勿
xi:席习西溪熙希喜锡系细稀夕昔惜牺析悉晰曦禧犀羲皙洗吸戏媳
xia:夏侠霞下厦峡吓瞎狭虾 xian:先仙鲜显现闲贤咸嫌献线县宪弦娴冼陷限险
xiang:项相向香乡响想象像祥翔湘襄详享巷箱 xiao:萧肖小笑晓孝校霄啸消宵潇箫销效
xie:谢解协胁写谐邪泄卸屑携鞋斜 xin:辛新心信欣鑫薪芯馨昕忻歆
xing:邢刑行形型星醒兴幸杏姓 xiong:熊雄兄胸凶 xiu:修秀休袖锈绣羞岫
xu:徐许续序绪需须虚旭叙蓄煦栩胥 xuan:宣轩玄旋选喧萱璇炫渲绚悬
xue:薛学雪血穴削靴 xun:荀寻询训迅巡驯逊勋熏循
ya:亚雅牙芽压呀哑鸦讶崖 yan:严颜阎晏燕言岩沿演烟延盐眼研炎艳彦焰雁堰檐衍验厌
yang:杨阳羊洋养样仰扬央秧氧痒漾 yao:姚尧遥摇瑶药耀窑咬要邀
ye:叶业夜也野冶爷页 yi:易亿伊仪宜依衣一移遗以已义议艺益意毅逸怡彝翼奕轶弈熠亦忆异倚椅疑医
yin:尹殷阴音银引印隐吟茵寅荫瘾饮因 ying:应英颖影迎莹营盈赢婴樱映硬鹰瑛滢
yong:永勇泳咏拥涌庸雍佣踊甬用 you:尤游友有右幼优忧邮犹柚酉又由油
yu:于余俞虞禹宇雨玉育羽豫遇域欲愉裕愚渔娱语狱预舆屿榆瑜煜钰喻寓郁誉与鱼
yuan:袁元原源远院愿园圆援缘垣媛渊 yue:岳乐越月悦跃阅粤约
yun:云运韵允耘芸陨孕蕴晕
za:杂 zai:载再在栽 zan:赞暂攒 zang:臧脏 zao:早造澡枣遭糟躁
ze:泽则责择 zeng:曾增赠憎 zha:查扎渣闸炸 zhai:翟宅摘窄债斋
zhan:詹展占战站粘湛崭盏 zhang:张章彰漳樟璋掌涨仗丈账帐障
zhao:赵昭照兆招罩肇钊爪 zhe:者浙这折哲蔗遮
zhen:甄珍真镇震振阵贞侦针诊枕臻桢祯 zheng:郑正政证争征整挣症睁蒸
zhi:智志之知直支植制质治只指纸至致执职织止芝枝汁旨脂稚滞侄挚掷芷祉值
zhong:钟仲忠中终众衷肿 zhou:周舟州洲宙皱粥骤轴昼
zhu:朱祝竹主住助珠诸猪注柱铸驻煮筑逐烛嘱竺渚著 zhuan:专砖转撰赚
zhuang:庄装壮撞妆桩 zhui:追坠 zhun:准 zhuo:卓桌拙灼酌浊着
zi:子字自资紫姿滋兹梓籽仔咨 zong:宗综总纵棕踪 zou:邹走奏
zu:祖组足族租阻 zui:最醉罪 zun:尊遵 zuo:左作坐座佐昨做
`;

/**
 * 姓氏优先的多音字（这些字在表里被强制指到「姓」的读音，而不是最常见的读音）：
 *   单 shan（非 dan）· 解 xie（非 jie）· 仇 qiu（非 chou）· 区 ou（非 qu）
 *   秘 bi（非 mi）· 朴 piao（非 pu）· 覃 qin（非 tan）· 查 zha（非 cha）
 *   乐 yue（非 le）· 曾 zeng（非 ceng）· 重 chong（非 zhong）· 繁 po（非 fan）
 *   华 hua（阳平，非 huà）· 翟 zhai（非 di）· 种 chong（非 zhong）
 *   谌 chen（非 shen）· 佘 she · 缪 miao（非 mou）· 召 shao（非 zhao）
 *   冼 xian · 郜 gao · 蒯 kuai · 阚 kan · 邝 kuang · 隽 juan
 * 复姓拆开就是单字，所以「欧阳」「司马」「诸葛」「上官」「令狐」这类不用单列，
 * 逐字查表天然就对：欧+阳 = ouyang、司+马 = sima。
 */

/** 汉字区间：基本汉字 + 常用扩展。姓名用不到 CJK-B 以上的生僻面。 */
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;

/** 模块加载时一次性展开成 Map。同一个字重复出现时先到先得。 */
const MAP = (() => {
  const m = new Map();
  for (const seg of PINYIN_TABLE.split(/\s+/)) {
    const i = seg.indexOf(':');
    if (i <= 0) continue;
    const py = seg.slice(0, i);
    for (const ch of seg.slice(i + 1)) {
      if (!HAN_RE.test(ch)) continue; // 表里手滑混进的标点/问号直接忽略，不进 Map
      if (!m.has(ch)) m.set(ch, py);
    }
  }
  return m;
})();

/** 表里到底收了多少字 —— 测试脚本会打出来，改表时能一眼看出规模变化 */
export const PINYIN_SIZE = MAP.size;

/** 单字查表。查不到返回空串（不是 '?' 也不是原字），让调用方自己决定怎么兜底。 */
export function pinyinOf(ch) {
  return MAP.get(ch) || '';
}

/**
 * 整串转拼音。
 *   - 汉字 → 拼音，音节之间**不加分隔**（张三 → zhangsan，符合中文姓名的英文写法习惯）
 *   - 非汉字（ASCII、空格、emoji、日文假名…）原样保留，交给调用方去规范化
 *   - 查不到的汉字直接消失（返回空串），绝不吐出问号或 U+FFFD ——
 *     那些字符进了 URL 就是一串 %EF%BF%BD，比没有还糟
 */
export function toPinyin(str) {
  const s = String(str ?? '');
  let out = '';
  for (const ch of s) {
    // for...of 按码位迭代，emoji 这类代理对不会被劈成两半
    out += HAN_RE.test(ch) ? MAP.get(ch) || '' : ch;
  }
  return out;
}
