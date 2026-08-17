/* ===================================================================
   幸福小事 · 内容库
   88 件精选小事 + 12 个留给你自己的空位 = 属于你的 100
   措辞原则：像朋友说话，不说教、不打分、门槛低到抬手就能做
   =================================================================== */

const CATEGORIES = [
  { id: 'morning', name: '晨间轻唤醒', short: '晨间', icon: '🌤', hue: 32,  desc: '让一天有个软软的开头' },
  { id: 'brain',   name: '小小充电站', short: '充电', icon: '📚', hue: 262, desc: '喂给脑子一点新鲜的东西' },
  { id: 'body',    name: '身体舒展时', short: '身体', icon: '🌿', hue: 152, desc: '身体也需要被好好照顾' },
  { id: 'emotion', name: '心情自留地', short: '心情', icon: '🎈', hue: 348, desc: '允许自己有各种各样的情绪' },
  { id: 'social',  name: '温柔的连接', short: '连接', icon: '🫖', hue: 20,  desc: '和喜欢的人靠近一点点' },
  { id: 'home',    name: '小窝整理术', short: '小窝', icon: '🏡', hue: 200, desc: '把生活的角落擦亮一点' },
  { id: 'night',   name: '睡前的仪式', short: '睡前', icon: '🌙', hue: 232, desc: '好好地把今天放下' },
];

/* type:    work = 忙碌的日子也做得到 / life = 更适合有空的日子
   weather: outdoor = 天气好的时候更棒 / indoor = 窝在室内刚刚好
   mins:    大概要花的分钟数（只是参考，不是任务）                      */
const TASKS = [
  // ───────── 🌤 晨间轻唤醒 ─────────
  { id: 1,  cat: 'morning', text: '睁眼后先别拿手机，躺着伸个大大的懒腰',       tip: '手机可以晚三分钟再见到你', type: 'work', weather: 'indoor',  mins: 1 },
  { id: 2,  cat: 'morning', text: '喝掉起床后的第一杯温水',                     tip: '身体睡了一夜，先给它一点水',   type: 'work', weather: 'indoor',  mins: 1 },
  { id: 3,  cat: 'morning', text: '推开窗，深深吸三口外面的空气',               tip: '闻闻看今天的空气是什么味道',   type: 'work', weather: 'outdoor', mins: 2 },
  { id: 4,  cat: 'morning', text: '把被子铺平，让床看起来清清爽爽',             tip: '晚上回来会谢谢现在的自己',     type: 'life', weather: 'indoor',  mins: 2 },
  { id: 5,  cat: 'morning', text: '对着镜子笑一下，说句「今天也没关系的」',     tip: '有点傻，但真的有用',           type: 'work', weather: 'indoor',  mins: 1 },
  { id: 6,  cat: 'morning', text: '认真洗个脸，慢慢涂好护肤品',                 tip: '像照顾一个很重要的人那样',     type: 'life', weather: 'indoor',  mins: 5 },
  { id: 7,  cat: 'morning', text: '闭着眼放空五分钟，什么都不想',               tip: '走神也没关系，那也是休息',     type: 'life', weather: 'indoor',  mins: 5 },
  { id: 8,  cat: 'morning', text: '好好吃顿早饭，哪怕只是一颗鸡蛋一杯奶',       tip: '来不及的话，路上吃也算',       type: 'work', weather: 'indoor',  mins: 10 },
  { id: 9,  cat: 'morning', text: '穿一件自己看着就开心的衣服',                 tip: '颜色会偷偷影响心情',           type: 'life', weather: 'indoor',  mins: 3 },
  { id: 10, cat: 'morning', text: '通勤路上听点喜欢的东西，播客或歌都行',       tip: '不用是「有用」的内容',         type: 'work', weather: 'outdoor', mins: 15 },
  { id: 11, cat: 'morning', text: '提前一站下车，慢慢走完剩下的路',             tip: '会看到平时错过的街景',         type: 'life', weather: 'outdoor', mins: 10 },
  { id: 12, cat: 'morning', text: '擦一擦桌面，从干净的台面开始今天',           tip: '五秒钟就能完成的小仪式',       type: 'work', weather: 'indoor',  mins: 2 },
  { id: 13, cat: 'morning', text: '写下今天最想做完的一件事，只要一件',         tip: '一件就够了，真的',             type: 'work', weather: 'indoor',  mins: 2 },

  // ───────── 📚 小小充电站 ─────────
  { id: 14, cat: 'brain', text: '翻两页书，纸的电子的都算',                     tip: '两页而已，不用有压力',         type: 'work', weather: 'indoor',  mins: 5 },
  { id: 15, cat: 'brain', text: '记住一个新词，中文外文都可以',                 tip: '记不住也没关系，见过就好',     type: 'work', weather: 'indoor',  mins: 3 },
  { id: 16, cat: 'brain', text: '关掉通知，专心做一件事 25 分钟',               tip: '被打断了就重新开始，不算失败', type: 'work', weather: 'indoor',  mins: 25 },
  { id: 17, cat: 'brain', text: '看一篇有点长的文章，不刷短视频',               tip: '让注意力多待一会儿',           type: 'work', weather: 'indoor',  mins: 15 },
  { id: 18, cat: 'brain', text: '看一段纪录片或演讲，哪怕只看开头',             tip: '看不完就存起来，也算数',       type: 'life', weather: 'indoor',  mins: 10 },
  { id: 19, cat: 'brain', text: '抄下一句今天打动你的话',                       tip: '手写会比截图记得更久',         type: 'life', weather: 'indoor',  mins: 3 },
  { id: 20, cat: 'brain', text: '问出一个「我其实不太懂」的问题',               tip: '不懂不丢人，装懂才累',         type: 'work', weather: 'indoor',  mins: 5 },
  { id: 21, cat: 'brain', text: '整理一个乱糟糟的文件夹',                       tip: '一个就好，别开大扫除',         type: 'work', weather: 'indoor',  mins: 10 },
  { id: 22, cat: 'brain', text: '练一点手上的小本事：几行代码、几个和弦、一张速写', tip: '重点是「玩」不是「练」',    type: 'life', weather: 'indoor',  mins: 15 },
  { id: 23, cat: 'brain', text: '玩个小游戏动动脑，数独、拼图都行',             tip: '玩本身就是目的',               type: 'life', weather: 'indoor',  mins: 10 },
  { id: 24, cat: 'brain', text: '学做一道没做过的菜，照着菜谱慢慢来',           tip: '难吃也是一次成功的实验',       type: 'life', weather: 'indoor',  mins: 30 },
  { id: 25, cat: 'brain', text: '完整听完一张专辑，按作者排好的顺序',           tip: '随机播放会错过很多设计',       type: 'life', weather: 'indoor',  mins: 40 },

  // ───────── 🌿 身体舒展时 ─────────
  { id: 26, cat: 'body', text: '坐够一小时就站起来，去接杯水',                 tip: '顺便看看窗外',                 type: 'work', weather: 'indoor',  mins: 3 },
  { id: 27, cat: 'body', text: '看看远处，让眼睛放空一会儿',                   tip: '越远越好，天上也行',           type: 'work', weather: 'indoor',  mins: 2 },
  { id: 28, cat: 'body', text: '转转肩膀，扩扩胸，做几下就舒服了',             tip: '低头太久了，抬一抬',           type: 'work', weather: 'indoor',  mins: 3 },
  { id: 29, cat: 'body', text: '爬一次楼梯，不赶时间的话',                     tip: '喘一点点就够了',               type: 'work', weather: 'indoor',  mins: 3 },
  { id: 30, cat: 'body', text: '出门散步二十分钟，晒到太阳最好',               tip: '不带目的地的那种散步',         type: 'life', weather: 'outdoor', mins: 20 },
  { id: 31, cat: 'body', text: '下午吃一份水果',                               tip: '削皮的过程也挺治愈',           type: 'work', weather: 'indoor',  mins: 5 },
  { id: 32, cat: 'body', text: '跟着视频动一动，跳操、拉伸、八段锦都行',       tip: '做一半就停也完全 OK',          type: 'life', weather: 'indoor',  mins: 15 },
  { id: 33, cat: 'body', text: '今天喝的第一杯换成温水或茶',                   tip: '奶茶留到明天也不会跑掉',       type: 'work', weather: 'indoor',  mins: 2 },
  { id: 34, cat: 'body', text: '靠墙把腿举高，躺十分钟',                       tip: '站了一天的腿会很感激',         type: 'life', weather: 'indoor',  mins: 10 },
  { id: 35, cat: 'body', text: '给自己按按手、按按肩，随便捏捏',               tip: '手劲不用大，舒服就行',         type: 'life', weather: 'indoor',  mins: 5 },
  { id: 36, cat: 'body', text: '这顿饭里加一种蔬菜，什么颜色都行',             tip: '不用算热量，加一点就好',       type: 'work', weather: 'indoor',  mins: 1 },
  { id: 37, cat: 'body', text: '用指腹揉揉头皮，从额头揉到后脑勺',             tip: '脑袋会一下子松下来',           type: 'work', weather: 'indoor',  mins: 3 },
  { id: 38, cat: 'body', text: '光脚踩踩地板或草地，感受一下温度',             tip: '很小的事，但很实在',           type: 'life', weather: 'outdoor', mins: 3 },

  // ───────── 🎈 心情自留地 ─────────
  { id: 39, cat: 'emotion', text: '发现自己情绪不好时，说一句「难受就难受吧」', tip: '不用马上好起来',              type: 'work', weather: 'indoor',  mins: 1 },
  { id: 40, cat: 'emotion', text: '写下三件今天值得谢谢的小事',                 tip: '「今天阳光很好」也完全算',     type: 'life', weather: 'indoor',  mins: 5 },
  { id: 41, cat: 'emotion', text: '在便利贴上写句给自己的话，贴在看得见的地方', tip: '写得肉麻一点也没人看见',      type: 'work', weather: 'indoor',  mins: 3 },
  { id: 42, cat: 'emotion', text: '拒绝一件其实不想做的事',                     tip: '「这次不方便」就是完整的理由', type: 'work', weather: 'indoor',  mins: 2 },
  { id: 43, cat: 'emotion', text: '看点搞笑的，笑出声那种',                     tip: '猫猫狗狗视频是万能的',         type: 'life', weather: 'indoor',  mins: 10 },
  { id: 44, cat: 'emotion', text: '中午戴上耳机闭眼十分钟，不听歌也不刷手机',   tip: '安静本身就是一种补给',         type: 'work', weather: 'indoor',  mins: 10 },
  { id: 45, cat: 'emotion', text: '闻一闻喜欢的味道，咖啡、橘子皮、香薰都行',   tip: '嗅觉是最快的情绪开关',         type: 'life', weather: 'indoor',  mins: 2 },
  { id: 46, cat: 'emotion', text: '把担心的事一条条写下来，然后合上本子',       tip: '写出来它们就没那么大了',       type: 'life', weather: 'indoor',  mins: 10 },
  { id: 47, cat: 'emotion', text: '想起一件最近的好运气，哪怕特别小',           tip: '红灯刚好变绿也算',             type: 'life', weather: 'indoor',  mins: 2 },
  { id: 48, cat: 'emotion', text: '给明天留一个小期待',                         tip: '「明天早饭吃烧麦」这种就很好', type: 'work', weather: 'indoor',  mins: 2 },
  { id: 49, cat: 'emotion', text: '抬头看一次天空，记住今天云的样子',           tip: '每天的云都不一样',             type: 'work', weather: 'outdoor', mins: 2 },
  { id: 50, cat: 'emotion', text: '听一首很久没听的老歌',                       tip: '记忆会自己跑出来',             type: 'life', weather: 'indoor',  mins: 5 },
  { id: 51, cat: 'emotion', text: '在窗边坐五分钟，什么也不做',                 tip: '发呆是被允许的',               type: 'life', weather: 'indoor',  mins: 5 },
  { id: 52, cat: 'emotion', text: '摸摸猫或狗，路上遇到的也算',                 tip: '摸不到就多看两眼',             type: 'life', weather: 'outdoor', mins: 3 },

  // ───────── 🫖 温柔的连接 ─────────
  { id: 53, cat: 'social', text: '给家里人发条具体的消息，别只发表情包',       tip: '「今天降温了记得穿厚点」就很好', type: 'work', weather: 'indoor',  mins: 3 },
  { id: 54, cat: 'social', text: '约一个很久没见的朋友，吃饭或打个语音',       tip: '「最近怎么样」四个字就能开头', type: 'life', weather: 'outdoor', mins: 30 },
  { id: 55, cat: 'social', text: '帮身边的人一个小忙，递纸巾、按电梯都算',     tip: '举手之劳最舒服',               type: 'life', weather: 'indoor',  mins: 1 },
  { id: 56, cat: 'social', text: '认真听别人说完一段话，不打断',               tip: '光是被听见就很珍贵',           type: 'work', weather: 'indoor',  mins: 5 },
  { id: 57, cat: 'social', text: '夸一个人，要说得很具体',                     tip: '「你今天这件外套颜色真好看」', type: 'work', weather: 'indoor',  mins: 2 },
  { id: 58, cat: 'social', text: '跟送货的、做饭的、打扫的人说声辛苦了',       tip: '一句话的事，对方会记住',       type: 'work', weather: 'outdoor', mins: 1 },
  { id: 59, cat: 'social', text: '和陌生人对上眼时，笑一下',                   tip: '尴尬也没关系，笑完就走',       type: 'life', weather: 'outdoor', mins: 1 },
  { id: 60, cat: 'social', text: '在朋友的动态下写一句走心的评论',             tip: '比点赞多花十秒钟',             type: 'life', weather: 'indoor',  mins: 2 },
  { id: 61, cat: 'social', text: '把今天听到的好笑的事讲给另一个人',           tip: '快乐是会传染的',               type: 'work', weather: 'indoor',  mins: 3 },
  { id: 62, cat: 'social', text: '给家里打个视频，聊点没营养的家常',           tip: '不用有正事才打电话',           type: 'life', weather: 'indoor',  mins: 15 },
  { id: 63, cat: 'social', text: '问一句「需要我帮忙吗」',                     tip: '被拒绝也没损失',               type: 'work', weather: 'indoor',  mins: 1 },
  { id: 64, cat: 'social', text: '和一起吃饭的人聊两句，别各自看手机',         tip: '一顿饭的时间而已',             type: 'work', weather: 'indoor',  mins: 15 },

  // ───────── 🏡 小窝整理术 ─────────
  { id: 65, cat: 'home', text: '花五分钟收拾桌子，只收拾桌子',                 tip: '定个闹钟，响了就停',           type: 'work', weather: 'indoor',  mins: 5 },
  { id: 66, cat: 'home', text: '换一次床单，钻进去的时候会很幸福',             tip: '洗过的床单有阳光味',           type: 'life', weather: 'indoor',  mins: 15 },
  { id: 67, cat: 'home', text: '记一笔今天的账，随手记就行',                   tip: '不为省钱，只为心里有数',       type: 'work', weather: 'indoor',  mins: 3 },
  { id: 68, cat: 'home', text: '找出一件半年没用的东西，送人或收好',           tip: '一件就够，不用大清理',         type: 'life', weather: 'indoor',  mins: 10 },
  { id: 69, cat: 'home', text: '清一清冰箱，把过期的请出去',                   tip: '顺便想想晚饭吃什么',           type: 'life', weather: 'indoor',  mins: 10 },
  { id: 70, cat: 'home', text: '给植物浇水，擦擦叶子',                         tip: '可以跟它说两句话',             type: 'life', weather: 'indoor',  mins: 5 },
  { id: 71, cat: 'home', text: '把喜欢的东西摆到每天看得见的地方',             tip: '好东西不该被收起来',           type: 'life', weather: 'indoor',  mins: 5 },
  { id: 72, cat: 'home', text: '清空电脑的回收站和下载文件夹',                 tip: '数字空间也需要透气',           type: 'work', weather: 'indoor',  mins: 5 },
  { id: 73, cat: 'home', text: '把明天要穿的衣服提前拿出来',                   tip: '明早会少一个决定',             type: 'work', weather: 'indoor',  mins: 3 },
  { id: 74, cat: 'home', text: '换掉用旧的毛巾或牙刷',                         tip: '很小的事，但会很清爽',         type: 'life', weather: 'indoor',  mins: 3 },
  { id: 75, cat: 'home', text: '换一张手机壁纸',                               tip: '一天要看几百次的地方',         type: 'work', weather: 'indoor',  mins: 2 },

  // ───────── 🌙 睡前的仪式 ─────────
  { id: 76, cat: 'night', text: '回想今天做成的一件事，不管多小',             tip: '起床本身就算一件',             type: 'work', weather: 'indoor',  mins: 3 },
  { id: 77, cat: 'night', text: '写两行日记，只写心情也行',                   tip: '流水账也是记录',               type: 'life', weather: 'indoor',  mins: 5 },
  { id: 78, cat: 'night', text: '放下手机，看十五分钟纸书',                   tip: '看着看着就困了，正好',         type: 'work', weather: 'indoor',  mins: 15 },
  { id: 79, cat: 'night', text: '泡个脚或泡个澡，水温热一点',                 tip: '泡到脚趾发暖为止',             type: 'life', weather: 'indoor',  mins: 20 },
  { id: 80, cat: 'night', text: '做五分钟深呼吸，让肚子鼓起来',               tip: '吸四拍，呼六拍',               type: 'work', weather: 'indoor',  mins: 5 },
  { id: 81, cat: 'night', text: '拉伸一下腿和腰，随便拉拉',                   tip: '疼就轻一点，别较劲',           type: 'life', weather: 'indoor',  mins: 10 },
  { id: 82, cat: 'night', text: '把手机放到伸手够不着的地方充电',             tip: '距离产生睡意',                 type: 'work', weather: 'indoor',  mins: 1 },
  { id: 83, cat: 'night', text: '躺好后从脚趾到头顶，一处处放松',             tip: '睡着了就是最好的结局',         type: 'life', weather: 'indoor',  mins: 10 },
  { id: 84, cat: 'night', text: '定好闹钟，告诉自己「睡够就是赢」',           tip: '不用非要早睡打卡',             type: 'work', weather: 'indoor',  mins: 1 },
  { id: 85, cat: 'night', text: '把没做完的事写下来，然后交给明天',           tip: '写下来就可以先不管了',         type: 'work', weather: 'indoor',  mins: 3 },
  { id: 86, cat: 'night', text: '听一段白噪音或很轻的音乐',                   tip: '雨声、海浪、咖啡馆都行',       type: 'life', weather: 'indoor',  mins: 10 },
  { id: 87, cat: 'night', text: '把房间的灯调暗一点',                         tip: '身体会知道该休息了',           type: 'life', weather: 'indoor',  mins: 1 },
  { id: 88, cat: 'night', text: '想着今天最开心的那一小下，然后睡着',         tip: '带着它进梦里',                 type: 'life', weather: 'indoor',  mins: 2 },
];

/* 剩下 12 件，留给你自己 */
const BUILTIN_COUNT = TASKS.length;   // 88
const TARGET_TOTAL  = 100;

// 里程碑（按当天完成件数触发）
const MILESTONES = [
  { count: 1,   points: 3,   title: '开了个头',   icon: '🌱', desc: '第一件完成啦，今天已经不一样了' },
  { count: 3,   points: 5,   title: '有点感觉了', icon: '🍃', desc: '三件小事，节奏起来了～' },
  { count: 6,   points: 8,   title: '越来越顺',   icon: '🌼', desc: '六件！今天的你在好好生活' },
  { count: 10,  points: 15,  title: '两位数啦',   icon: '🌈', desc: '十件小事，是很了不起的一天' },
  { count: 15,  points: 25,  title: '幸福体质',   icon: '🧁', desc: '十五件，你把日子过得很有滋味' },
  { count: 20,  points: 40,  title: '闪闪发光',   icon: '✨', desc: '二十件！今天你把生活抱得好紧' },
  { count: 30,  points: 70,  title: '超能小事家', icon: '🏆', desc: '三十件，这一天值得被记住' },
  { count: 50,  points: 120, title: '生活的主角', icon: '👑', desc: '五十件！今天完全属于你' },
];

// 心情
const MOOD_OPTIONS = [
  { emoji: '🥰', label: '超好', hue: 348 },
  { emoji: '😊', label: '还不错', hue: 40 },
  { emoji: '😌', label: '平平的', hue: 200 },
  { emoji: '🥲', label: '有点累', hue: 262 },
  { emoji: '😔', label: '不太好', hue: 220 },
];

// 每日一句（按日期轮换，温柔向）
const DAILY_QUOTES = [
  '今天不用变得更好，保持原样也很好。',
  '慢一点也来得及，反正路是你自己的。',
  '你已经做得比自己以为的多很多了。',
  '不是每天都要有意义，休息也是过日子。',
  '把标准降低一点，快乐就会多一点。',
  '今天的坏心情，明天不一定还在。',
  '你值得一杯热的东西和一个好觉。',
  '完成比完美重要，开始比完成重要。',
  '允许自己什么都不做，就待一会儿。',
  '生活是很多很小的事叠起来的。',
  '照顾好自己，是今天最要紧的事。',
  '没做到的那些，明天再说吧。',
  '你今天已经很努力地活着了。',
  '试着对自己说话温柔一点。',
  '喜欢的事不用有用，喜欢就够了。',
  '难过的时候，不用假装没事。',
  '风会停，雨会过，今天也会翻篇。',
  '你不需要向谁证明什么。',
  '把今天过完，就是完成任务。',
  '好好吃饭，好好睡觉，剩下的慢慢来。',
  '你身上有很多好，只是自己没在看。',
  '所有的小事，加起来就是一生。',
];
