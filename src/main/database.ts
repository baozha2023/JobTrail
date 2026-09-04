import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AppPaths } from './config'

type SqliteDatabase = InstanceType<typeof Database>
const DB_SCHEMA_VERSION = 3

export const DEFAULT_STATUS_LABELS = [
  '已查看', '感兴趣', '待投递', '初筛', '笔试', 'AI面试',
  '一面', '二面', '三面', 'HR面', 'Offer', '淘汰', '主动放弃',
]

type BuiltinIndustrySeed = {
  id: number
  name: string
  sort_order: number
  is_builtin: 1
}

const BUILTIN_INDUSTRIES: BuiltinIndustrySeed[] = [
  { id: 1, name: '互联网', sort_order: 0, is_builtin: 1 },
  { id: 2, name: '游戏', sort_order: 1, is_builtin: 1 },
  { id: 3, name: '人工智能', sort_order: 2, is_builtin: 1 },
  { id: 4, name: '软件', sort_order: 3, is_builtin: 1 },
  { id: 5, name: '芯片', sort_order: 4, is_builtin: 1 },
  { id: 6, name: '硬件', sort_order: 5, is_builtin: 1 },
  { id: 7, name: '通信与硬件', sort_order: 6, is_builtin: 1 },
  { id: 8, name: '电子与硬件', sort_order: 7, is_builtin: 1 },
  { id: 9, name: '计算机与IT服务', sort_order: 8, is_builtin: 1 },
  { id: 10, name: '金融', sort_order: 9, is_builtin: 1 },
  { id: 11, name: '银行', sort_order: 10, is_builtin: 1 },
  { id: 12, name: '证券与投资', sort_order: 11, is_builtin: 1 },
  { id: 13, name: '保险', sort_order: 12, is_builtin: 1 },
  { id: 14, name: '电商与零售', sort_order: 13, is_builtin: 1 },
  { id: 15, name: '消费品', sort_order: 14, is_builtin: 1 },
  { id: 16, name: '食品饮料', sort_order: 15, is_builtin: 1 },
  { id: 17, name: '医疗健康', sort_order: 16, is_builtin: 1 },
  { id: 18, name: '生物医药', sort_order: 17, is_builtin: 1 },
  { id: 19, name: '汽车', sort_order: 18, is_builtin: 1 },
  { id: 20, name: '新能源', sort_order: 19, is_builtin: 1 },
  { id: 21, name: '制造业', sort_order: 20, is_builtin: 1 },
  { id: 22, name: '化工与材料', sort_order: 21, is_builtin: 1 },
  { id: 23, name: '建筑与房地产', sort_order: 22, is_builtin: 1 },
  { id: 24, name: '家居与物业', sort_order: 23, is_builtin: 1 },
  { id: 25, name: '物流与供应链', sort_order: 24, is_builtin: 1 },
  { id: 26, name: '交通运输', sort_order: 25, is_builtin: 1 },
  { id: 27, name: '航空航天', sort_order: 26, is_builtin: 1 },
  { id: 28, name: '能源与矿业', sort_order: 27, is_builtin: 1 },
  { id: 29, name: '电力与公用事业', sort_order: 28, is_builtin: 1 },
  { id: 30, name: '教育', sort_order: 29, is_builtin: 1 },
  { id: 31, name: '旅游与酒店', sort_order: 30, is_builtin: 1 },
  { id: 32, name: '媒体与内容', sort_order: 31, is_builtin: 1 },
  { id: 33, name: '广告与营销', sort_order: 32, is_builtin: 1 },
  { id: 34, name: '文化娱乐', sort_order: 33, is_builtin: 1 },
  { id: 35, name: '专业服务与咨询', sort_order: 34, is_builtin: 1 },
  { id: 36, name: '法律服务', sort_order: 35, is_builtin: 1 },
  { id: 37, name: '人力资源', sort_order: 36, is_builtin: 1 },
  { id: 38, name: '农业与农牧', sort_order: 37, is_builtin: 1 },
  { id: 39, name: '政府与公共服务', sort_order: 38, is_builtin: 1 },
  { id: 40, name: '跨境贸易', sort_order: 39, is_builtin: 1 },
  { id: 41, name: '生活服务', sort_order: 40, is_builtin: 1 },
  { id: 42, name: '环保与循环经济', sort_order: 41, is_builtin: 1 },
  { id: 43, name: '其他服务', sort_order: 42, is_builtin: 1 },
]

type BuiltinCompanySeed = {
  name: string
  industryId: number
  careerUrl: string
  aliases: string[]
}

const BUILTIN_COMPANIES: BuiltinCompanySeed[] = [
  { name: '腾讯', industryId: 1, careerUrl: 'https://join.qq.com/', aliases: ['Tencent'] },
  { name: '字节跳动', industryId: 1, careerUrl: 'https://jobs.bytedance.com/', aliases: ['ByteDance'] },
  { name: '阿里巴巴', industryId: 1, careerUrl: 'https://talent.alibaba.com/', aliases: ['阿里'] },
  { name: '蚂蚁集团', industryId: 1, careerUrl: 'https://www.antgroup.com/careers', aliases: ['Ant Group'] },
  { name: '美团', industryId: 1, careerUrl: 'https://zhaopin.meituan.com/', aliases: ['Meituan'] },
  { name: '京东', industryId: 1, careerUrl: 'https://zhaopin.jd.com/', aliases: ['JD'] },
  { name: '百度', industryId: 1, careerUrl: 'https://talent.baidu.com/', aliases: ['Baidu'] },
  { name: '快手', industryId: 1, careerUrl: 'https://zhaopin.kuaishou.cn/', aliases: ['Kuaishou'] },
  { name: '小红书', industryId: 1, careerUrl: 'https://job.xiaohongshu.com/', aliases: ['Xiaohongshu'] },
  { name: '哔哩哔哩', industryId: 1, careerUrl: 'https://jobs.bilibili.com/', aliases: ['B站'] },
  { name: '网易', industryId: 1, careerUrl: 'https://campus.163.com/', aliases: ['NetEase'] },
  { name: '拼多多', industryId: 1, careerUrl: 'https://careers.pinduoduo.com/', aliases: ['PDD'] },
  { name: '滴滴', industryId: 1, careerUrl: 'https://talent.didiglobal.com/', aliases: ['Didi'] },
  { name: '携程', industryId: 1, careerUrl: 'https://jobs.ctrip.com/', aliases: ['Trip.com'] },
  { name: '米哈游', industryId: 2, careerUrl: 'https://jobs.mihoyo.com/', aliases: ['HoYoverse'] },
  { name: '莉莉丝游戏', industryId: 2, careerUrl: 'https://lilithgames.jobs.feishu.cn/', aliases: ['Lilith Games'] },
  { name: '鹰角网络', industryId: 2, careerUrl: 'https://job.hypergryph.com/', aliases: ['Hypergryph'] },
  { name: '完美世界', industryId: 2, careerUrl: 'https://zhaopin.wanmei.com/', aliases: ['Perfect World'] },
  { name: '库洛游戏', industryId: 2, careerUrl: 'https://kurogame.com/', aliases: ['Kuro Games'] },
  { name: '科大讯飞', industryId: 3, careerUrl: 'https://campus.iflytek.com/', aliases: ['iFLYTEK'] },
  { name: '智谱AI', industryId: 3, careerUrl: 'https://www.zhipuai.cn/', aliases: ['Zhipu AI'] },
  { name: 'MiniMax', industryId: 3, careerUrl: 'https://www.minimaxi.com/careers', aliases: ['稀宇科技'] },
  { name: '商汤科技', industryId: 3, careerUrl: 'https://www.sensetime.com/', aliases: ['SenseTime'] },
  { name: '比亚迪', industryId: 19, careerUrl: 'https://job.byd.com/', aliases: ['BYD'] },
  { name: '蔚来', industryId: 19, careerUrl: 'https://nio.com/careers', aliases: ['NIO'] },
  { name: '理想汽车', industryId: 19, careerUrl: 'https://careers.lixiang.com/', aliases: ['Li Auto'] },
  { name: '小鹏汽车', industryId: 19, careerUrl: 'https://jobs.xiaopeng.com/', aliases: ['XPeng'] },
  { name: '小米', industryId: 6, careerUrl: 'https://hr.xiaomi.com/', aliases: ['Xiaomi'] },
  { name: '华为', industryId: 7, careerUrl: 'https://career.huawei.com/', aliases: ['Huawei'] },
  { name: '中兴通讯', industryId: 7, careerUrl: 'https://job.zte.com.cn/', aliases: ['ZTE'] },
  { name: '联想', industryId: 6, careerUrl: 'https://jobs.lenovo.com/', aliases: ['Lenovo'] },
  { name: '海尔', industryId: 21, careerUrl: 'https://maker.haier.com/', aliases: ['Haier'] },
  { name: '宁德时代', industryId: 20, careerUrl: 'https://www.catl.com/careers/', aliases: ['CATL'] },
  { name: '寒武纪', industryId: 5, careerUrl: 'https://www.cambricon.com/', aliases: ['Cambricon'] },
  { name: '地平线', industryId: 5, careerUrl: 'https://www.horizon.cc/', aliases: ['Horizon Robotics'] },
  { name: '英伟达', industryId: 5, careerUrl: 'https://www.nvidia.com/en-us/about-nvidia/careers/', aliases: ['NVIDIA'] },
  { name: '微软', industryId: 4, careerUrl: 'https://careers.microsoft.com/', aliases: ['Microsoft'] },
  { name: '谷歌', industryId: 4, careerUrl: 'https://careers.google.com/', aliases: ['Google'] },
  { name: '亚马逊', industryId: 4, careerUrl: 'https://www.amazon.jobs/', aliases: ['Amazon'] },
  { name: '得物', industryId: 14, careerUrl: 'https://hr.dewu.com/', aliases: ['POIZON'] },
  { name: '唯品会', industryId: 14, careerUrl: 'https://job.vip.com/', aliases: ['Vipshop'] },
  { name: '叮咚买菜', industryId: 14, careerUrl: 'https://careers.dingdong-inc.com/', aliases: ['Dingdong'] },
  { name: '哈啰出行', industryId: 26, careerUrl: 'https://hr.hellobike.com/', aliases: ['HelloBike'] },
  { name: '曹操出行', industryId: 26, careerUrl: 'https://www.caocaokeji.cn/', aliases: ['Cao Cao Mobility'] },
  { name: '同程旅行', industryId: 31, careerUrl: 'https://job.ly.com/', aliases: ['Tongcheng Travel'] },
  { name: '途虎养车', industryId: 19, careerUrl: 'https://hr.tuhu.cn/', aliases: ['Tuhu'] },
  { name: 'SHEIN', industryId: 40, careerUrl: 'https://careers.shein.com/', aliases: ['希音'] },
  { name: '货拉拉', industryId: 25, careerUrl: 'https://www.huolala.cn/', aliases: ['Lalamove'] },
  { name: '菜鸟', industryId: 25, careerUrl: 'https://talent.cainiao.com/', aliases: ['Cainiao'] },
  { name: '顺丰', industryId: 25, careerUrl: 'https://hr.sf-express.com/', aliases: ['SF Express'] },
  { name: '牧原股份', industryId: 38, careerUrl: 'https://www.muyuanfoods.com/', aliases: ['Muyuan'] },
  { name: '伊利', industryId: 16, careerUrl: 'https://campus.yili.com/', aliases: ['Yili'] },
  { name: '海康威视', industryId: 8, careerUrl: 'https://campus.hikvision.com/', aliases: ['Hikvision'] },
  { name: '大疆', industryId: 8, careerUrl: 'https://www.dji.com/cn/careers', aliases: ['DJI'] },
  { name: '立讯精密', industryId: 8, careerUrl: 'https://www.luxshare-ict.com/', aliases: ['Luxshare'] },
  { name: '隆基绿能', industryId: 20, careerUrl: 'https://www.longi.com/cn/careers/', aliases: ['LONGi'] },
  { name: '远景能源', industryId: 20, careerUrl: 'https://www.envision-group.com/careers', aliases: ['Envision'] },
  { name: '恒瑞医药', industryId: 18, careerUrl: 'https://www.hengrui.com/join.html', aliases: ['Hengrui'] },
  { name: '招商银行', industryId: 11, careerUrl: 'https://career.cmbchina.com/', aliases: ['CMB'] },
  { name: '360', industryId: 1, careerUrl: 'https://hr.360.cn/hr/list', aliases: ['奇虎360'] },
  { name: '微博', industryId: 1, careerUrl: 'https://career.sina.com.cn/campus-recruitment/sina/43536', aliases: ['Weibo'] },
  { name: '知乎', industryId: 1, careerUrl: 'https://app.mokahr.com/campus-recruitment/zhihu/68321?locale=zh-CN#/jobs', aliases: ['Zhihu'] },
  { name: '搜狐', industryId: 1, careerUrl: 'https://app.mokahr.com/social-recruitment/sohu/43256?locale=zh-CN#/jobs?page=1&anchorName=jobsList', aliases: ['Sohu'] },
  { name: '中国移动', industryId: 7, careerUrl: 'https://job.10086.cn/', aliases: ['China Mobile'] },
  { name: '金山办公', industryId: 4, careerUrl: 'https://join.wps.cn/', aliases: ['WPS'] },
  { name: '迅雷', industryId: 4, careerUrl: 'https://career.xunlei.com/', aliases: ['Xunlei'] },
  { name: '云从科技', industryId: 3, careerUrl: 'http://jobs.cloudwalk.com/apply/cloudwalk/4871/#/', aliases: ['CloudWalk'] },
  { name: '旷视科技', industryId: 3, careerUrl: 'http://zhaopin.megvii.com/', aliases: ['Megvii'] },
  { name: '依图科技', industryId: 3, careerUrl: 'https://www.yitutech.com/cn/career?mode=social', aliases: ['YITU'] },
  { name: '甲骨文', industryId: 4, careerUrl: 'https://www.oracle.com/cn/careers/', aliases: ['Oracle'] },
  { name: 'SAP', industryId: 4, careerUrl: 'https://jobs.sap.com/?locale=zh_CN', aliases: ['思爱普'] },
  { name: 'IBM', industryId: 4, careerUrl: 'https://www.ibm.com/cn-zh/careers/', aliases: ['国际商业机器'] },
  { name: '爱奇艺', industryId: 32, careerUrl: 'https://zhaopin.iqiyi.com/', aliases: ['iQIYI'] },
  { name: '英特尔', industryId: 5, careerUrl: 'https://chinacampus.jobs.intel.cn/intel/position/index?recruitmentType=CAMPUSRECRUITMENT', aliases: ['Intel'] },
  { name: 'AMD', industryId: 5, careerUrl: 'https://careers.amd.com/jobs?country=China&page=1', aliases: ['超威半导体'] },
  { name: '高通', industryId: 5, careerUrl: 'https://www.qualcomm.cn/company/careers', aliases: ['Qualcomm'] },
  { name: '台积电', industryId: 5, careerUrl: 'https://careers.tsmc.com/en_US/careers', aliases: ['TSMC'] },
  { name: '中芯国际', industryId: 5, careerUrl: 'https://smics.zhiye.com/social', aliases: ['SMIC'] },
  { name: '荣耀', industryId: 6, careerUrl: 'https://www.honor.com/cn/career/', aliases: ['HONOR'] },
  { name: 'OPPO', industryId: 6, careerUrl: 'https://careers.oppo.com/university/oppo/', aliases: ['欧珀'] },
  { name: 'vivo', industryId: 6, careerUrl: 'https://hr.vivo.com/', aliases: ['维沃'] },
  { name: '京东方', industryId: 8, careerUrl: 'https://campus.boe.com/#/jobs', aliases: ['BOE'] },
  { name: 'TCL', industryId: 8, careerUrl: 'https://zhaopin.tcl.com/', aliases: ['TCL科技'] },
  { name: '传音控股', industryId: 6, careerUrl: 'https://transsion.zhiye.com/', aliases: ['Transsion'] },
  { name: '安克创新', industryId: 8, careerUrl: 'https://career.anker.com.cn/', aliases: ['Anker'] },
  { name: '美的集团', industryId: 21, careerUrl: 'https://recruit.midea.com/recruitOut/ihr/home/index', aliases: ['Midea'] },
  { name: '格力电器', industryId: 21, careerUrl: 'https://zhaopin.greeyun.com/home', aliases: ['Gree'] },
  { name: '海信', industryId: 21, careerUrl: 'https://jobs.hisense.com/', aliases: ['Hisense'] },
  { name: '吉利汽车', industryId: 19, careerUrl: 'https://campus.geely.com/campus-recruitment/geely/78436/#/jobs', aliases: ['Geely'] },
  { name: '长城汽车', industryId: 19, careerUrl: 'https://zhaopin.gwm.cn/', aliases: ['GWM'] },
  { name: '中国电信', industryId: 7, careerUrl: 'https://job.chinatelecom.com.cn/wt/TELE/web/index', aliases: ['China Telecom'] },
  { name: '上汽集团', industryId: 19, careerUrl: 'https://www.saicmotor.com/chinese/rlzy/index.html', aliases: ['SAIC'] },
  { name: '赛力斯', industryId: 19, careerUrl: 'https://www.seres.cn/p/career-development.html', aliases: ['SERES'] },
  { name: '国轩高科', industryId: 20, careerUrl: 'https://gotion.zhiye.com/', aliases: ['Gotion High-tech'] },
  { name: '阳光电源', industryId: 20, careerUrl: 'https://jobs.sungrowpower.com/', aliases: ['Sungrow'] },
  { name: '亿纬锂能', industryId: 20, careerUrl: 'https://www.evebattery.com/join-us', aliases: ['EVE Energy'] },
  { name: '天合光能', industryId: 20, careerUrl: 'https://app.mokahr.com/social-recruitment/trinasolar/98958#/', aliases: ['Trina Solar'] },
  { name: '新东方', industryId: 30, careerUrl: 'https://zhaopin.xdf.cn/', aliases: ['New Oriental'] },
  { name: '中国工商银行', industryId: 11, careerUrl: 'https://job.icbc.com.cn/pc/index.html', aliases: ['ICBC'] },
  { name: '中国建设银行', industryId: 11, careerUrl: 'https://job2.ccb.com/cn/job/index.html', aliases: ['CCB'] },
  { name: '中国银行', industryId: 11, careerUrl: 'https://www.boc.cn/aboutboc/bi4/', aliases: ['BOC'] },
  { name: '交通银行', industryId: 11, careerUrl: 'https://job.bankcomm.com/#/', aliases: ['Bank of Communications'] },
  { name: '中国平安', industryId: 13, careerUrl: 'https://www.pingan.com/official/recruitment', aliases: ['Ping An'] },
  { name: '中信证券', industryId: 12, careerUrl: 'https://careers.citics.com/', aliases: ['CITIC Securities'] },
  { name: '东方财富', industryId: 10, careerUrl: 'https://zhaopin.eastmoney.com/', aliases: ['Eastmoney'] },
  { name: '蒙牛', industryId: 16, careerUrl: 'https://mengniu.zhiye.com/custom/index', aliases: ['Mengniu'] },
  { name: '宝洁', industryId: 15, careerUrl: 'https://careers.pg.com.cn/cn/zh/home', aliases: ['P&G'] },
  { name: '联合利华', industryId: 15, careerUrl: 'https://careers.unilever.com/en/location/china-jobs/34155/1814991/2', aliases: ['Unilever'] },
  { name: '普华永道', industryId: 35, careerUrl: 'https://www.pwccn.com/zh/careers.html', aliases: ['PwC'] },
  { name: '腾讯音乐', industryId: 1, careerUrl: 'https://join.tencentmusic.com/', aliases: ['TME'] },
  { name: '得到', industryId: 30, careerUrl: 'https://dedao.jobs.feishu.cn/shezhao', aliases: ['Dedao'] },
  { name: '百川智能', industryId: 3, careerUrl: 'https://careers.baichuan-inc.com/', aliases: ['Baichuan AI'] },
  { name: '月之暗面', industryId: 3, careerUrl: 'https://careers.kimi.com/', aliases: ['Moonshot AI'] },
  { name: '壁仞科技', industryId: 5, careerUrl: 'https://www.birentech.com/join/', aliases: ['Biren Technology'] },
  { name: '新华三集团', industryId: 9, careerUrl: 'https://career.h3c.com/h3c/home/index', aliases: ['H3C'] },
  { name: '浪潮集团', industryId: 9, careerUrl: 'http://career.inspur.com/campus2027/index.html', aliases: ['Inspur'] },
  { name: '中科创达', industryId: 4, careerUrl: 'https://www.thundersoft.com/join-us/', aliases: ['ThunderSoft'] },
  { name: '新紫光集团', industryId: 9, careerUrl: 'https://www.unigroup.com.cn/Join-Us/join.html', aliases: ['Unigroup'] },
  { name: '长江存储', industryId: 5, careerUrl: 'https://www.ymtc.com/cn/joinus.html', aliases: ['YMTC'] },
  { name: '兆易创新', industryId: 5, careerUrl: 'https://www.gigadevice.com.cn/about/career', aliases: ['GigaDevice'] },
  { name: '中微公司', industryId: 5, careerUrl: 'https://www.amec-inc.com/index/Lists/index/catid/100.html', aliases: ['AMEC'] },
  { name: '广汽集团', industryId: 19, careerUrl: 'https://gacrnd.zhiye.com/jobs', aliases: ['GAC'] },
  { name: '中国一汽', industryId: 19, careerUrl: 'https://faw-zhaopin.hotjob.cn/', aliases: ['FAW'] },
  { name: '东风汽车', industryId: 19, careerUrl: 'https://www.dfmc.com.cn/zhaopin/xiaoyuanzhaopin.html', aliases: ['Dongfeng'] },
  { name: '零跑汽车', industryId: 19, careerUrl: 'https://leapmotor.zhiye.com/social', aliases: ['Leapmotor'] },
  { name: '中国人寿', industryId: 13, careerUrl: 'https://chinalife.zhiye.com/custom/index', aliases: ['China Life'] },
  { name: '中国人民保险', industryId: 13, careerUrl: 'https://picc.zhiye.com/custom/index', aliases: ['PICC'] },
  { name: '中国太平洋保险', industryId: 13, careerUrl: 'https://www.cpic.com.cn/aboutUs/rlzy/ygzp/', aliases: ['CPIC'] },
  { name: '中金公司', industryId: 12, careerUrl: 'https://cicc.zhiye.com/custom/campusdt?hideMenu=1', aliases: ['CICC'] },
  { name: '华泰证券', industryId: 12, careerUrl: 'https://www.htsc.com.cn/recruit/', aliases: ['Huatai Securities'] },
  { name: '广发证券', industryId: 12, careerUrl: 'https://job.gf.com.cn/', aliases: ['GF Securities'] },
  { name: '中信银行', industryId: 11, careerUrl: 'https://job.citicbank.com/', aliases: ['China CITIC Bank'] },
  { name: '民生银行', industryId: 11, careerUrl: 'https://career.cmbc.com.cn/', aliases: ['CMBC'] },
  { name: '迈瑞医疗', industryId: 17, careerUrl: 'https://www.mindray.com/cn/career', aliases: ['Mindray'] },
  { name: '联影医疗', industryId: 17, careerUrl: 'https://global.united-imaging.com/zh-cn/careers', aliases: ['United Imaging'] },
  { name: '药明康德', industryId: 18, careerUrl: 'https://wuxiapptec.zhiye.com/jobs', aliases: ['WuXi AppTec'] },
  { name: '复星医药', industryId: 18, careerUrl: 'https://www.fosunpharma.com/careers/', aliases: ['Fosun Pharma'] },
  { name: '百济神州', industryId: 18, careerUrl: 'https://www.beonemedicines.com.cn/careers/', aliases: ['BeiGene'] },
  { name: '泡泡玛特', industryId: 15, careerUrl: 'https://popmart.zhiye.com/', aliases: ['POP MART'] },
  { name: '名创优品', industryId: 15, careerUrl: 'https://miniso.zhiye.com/', aliases: ['MINISO'] },
  { name: '喜茶', industryId: 16, careerUrl: 'https://heytea.zhiye.com/', aliases: ['HEYTEA'] },
  { name: '元气森林', industryId: 16, careerUrl: 'https://k11pnjpvz1.jobs.feishu.cn/index', aliases: ['Genki Forest'] },
  { name: '李宁', industryId: 15, careerUrl: 'https://lining.hotjob.cn/', aliases: ['Li-Ning'] },
  { name: '安踏', industryId: 15, careerUrl: 'https://jobs.anta.com/', aliases: ['ANTA'] },
  { name: '百胜中国', industryId: 16, careerUrl: 'https://yumchina.zhiye.com/alljob?c=1', aliases: ['Yum China'] },
  { name: '中国石油', industryId: 28, careerUrl: 'https://www.cnpc.com.cn/cnpc/jrwm/jrwm_index.shtml', aliases: ['CNPC'] },
  { name: '中国石化', industryId: 28, careerUrl: 'https://job.sinopec.com/', aliases: ['Sinopec'] },
  { name: '国家电网', industryId: 29, careerUrl: 'https://zhaopin.sgcc.com.cn/sgcchr/static/home.html', aliases: ['State Grid'] },
  { name: '南方电网', industryId: 29, careerUrl: 'https://zhaopin.csg.cn/', aliases: ['China Southern Power Grid'] },
  { name: '中国国航', industryId: 27, careerUrl: 'https://zhaopin.airchina.com.cn/cn/about_us/recruitment/index.shtml', aliases: ['Air China'] },
  { name: '南方航空', industryId: 27, careerUrl: 'https://job.csair.com/', aliases: ['China Southern Airlines'] },
  { name: '东方航空', industryId: 27, careerUrl: 'https://job.ceair.com/', aliases: ['China Eastern'] },
  { name: '华住集团', industryId: 31, careerUrl: 'https://campus.hworld.com/', aliases: ['H World'] },
  { name: '贝壳', industryId: 23, careerUrl: 'https://campus.ke.com/', aliases: ['KE Holdings'] },
  { name: '龙湖集团', industryId: 23, careerUrl: 'https://www.longfor.com/join/job.html', aliases: ['Longfor'] },
  { name: '喜马拉雅', industryId: 32, careerUrl: 'https://jobs.ximalaya.com/', aliases: ['Ximalaya'] },
  { name: 'Keep', industryId: 41, careerUrl: 'https://www.calorietech.com/join', aliases: ['卡路里科技'] },
  { name: 'Soul', industryId: 1, careerUrl: 'https://www.soulapp.cn/career', aliases: ['Soul App'] },
  { name: '云天励飞', industryId: 3, careerUrl: 'https://www.intellif.com/int/join.html', aliases: ['Intellifusion'] },
]

export class DatabaseManager {
  readonly db: SqliteDatabase

  constructor(private readonly paths: AppPaths) {
    fs.mkdirSync(path.dirname(paths.database), { recursive: true })
    this.db = new Database(paths.database)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    try {
      this.initialize()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS industries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        industry_id INTEGER,
        career_url TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        alias TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(company_id, alias)
      );

      CREATE TABLE IF NOT EXISTS resume_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER,
        sha256 TEXT,
        note TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        department TEXT,
        location TEXT,
        source TEXT,
        job_url TEXT,
        description TEXT,
        status_id INTEGER NOT NULL,
        resume_version_id INTEGER,
        discovered_at INTEGER,
        applied_at INTEGER,
        deadline_at INTEGER,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER,
        title TEXT NOT NULL,
        event_type TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL CHECK (end_at >= start_at),
        is_all_day INTEGER NOT NULL DEFAULT 0 CHECK (is_all_day IN (0, 1)),
        timezone TEXT NOT NULL,
        location TEXT,
        description TEXT,
        reminder_minutes INTEGER,
        is_completed INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_opportunities_status_id ON opportunities(status_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_company_id ON opportunities(company_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_deadline_at ON opportunities(deadline_at);
      CREATE INDEX IF NOT EXISTS idx_opportunities_updated_at ON opportunities(updated_at);
      CREATE INDEX IF NOT EXISTS idx_companies_industry_id ON companies(industry_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events(start_at, end_at);
    `)

    const version = Number(this.db.pragma('user_version', { simple: true }))
    if (version === 0) {
      this.seed()
      this.db.pragma(`user_version = ${DB_SCHEMA_VERSION}`)
    } else if (version === DB_SCHEMA_VERSION) {
      this.seed()
      this.refreshLegacyBuiltinCareerUrls()
    } else if (version !== DB_SCHEMA_VERSION) {
      throw new Error(`不支持的数据库结构版本：${version}，需要版本 ${DB_SCHEMA_VERSION}`)
    }
  }

  private seed(): void {
    const now = Date.now()
    const insertStatus = this.db.prepare(`
      INSERT OR IGNORE INTO statuses (label, sort_order, is_builtin, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `)
    const insertIndustry = this.db.prepare(`
      INSERT OR IGNORE INTO industries (id, name, sort_order, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertCompany = this.db.prepare(`
      INSERT INTO companies (name, industry_id, career_url, is_builtin, is_favorite, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, ?, ?)
      ON CONFLICT(name) DO UPDATE SET name = excluded.name
      RETURNING id
    `)
    const addAlias = this.db.prepare(`
      INSERT OR IGNORE INTO company_aliases (company_id, alias, created_at)
      VALUES (?, ?, ?)
    `)
    const removeGeneratedAliases = this.db.prepare(`
      DELETE FROM company_aliases
      WHERE company_id IN (SELECT id FROM companies WHERE is_builtin = 1)
        AND alias = (SELECT name FROM companies WHERE companies.id = company_aliases.company_id)
    `)

    const seedTransaction = this.db.transaction(() => {
      DEFAULT_STATUS_LABELS.forEach((label, index) => insertStatus.run(label, index, now, now))
      BUILTIN_INDUSTRIES.forEach((industry) => insertIndustry.run(
        industry.id,
        industry.name,
        industry.sort_order,
        industry.is_builtin,
        now,
        now,
      ))
      removeGeneratedAliases.run()
      for (const companySeed of BUILTIN_COMPANIES) {
        const company = insertCompany.get(companySeed.name, companySeed.industryId, companySeed.careerUrl, now, now) as { id: number }
        const companyId = Number(company.id)
        for (const alias of companySeed.aliases) addAlias.run(companyId, alias, now)
      }
    })
    seedTransaction()
  }

  private refreshLegacyBuiltinCareerUrls(): void {
    this.db.prepare(`
      UPDATE companies
      SET career_url = ?, updated_at = ?
      WHERE name = ? AND is_builtin = 1 AND career_url = ?
    `).run('https://www.minimaxi.com/careers', Date.now(), 'MiniMax', 'https://www.minimaxi.com/')
  }
}
