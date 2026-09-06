import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AppPaths } from './config'
import { BUILTIN_COMPANIES } from './builtin-companies'

type SqliteDatabase = InstanceType<typeof Database>
export const DB_SCHEMA_VERSION = 8

const DEFAULT_STATUS_INSERT_SQL = `
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (1, '感兴趣', 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (2, '待投递', 2, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (3, '初筛', 3, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (4, '笔试', 4, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (5, 'AI面试', 5, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (6, '一面', 6, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (7, '二面', 7, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (8, '三面', 8, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (9, 'HR面', 9, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (10, 'Offer', 10, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (11, '淘汰', 11, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
    INSERT INTO statuses (id, label, sort_order, is_builtin, created_at, updated_at)
    VALUES (12, '主动放弃', 12, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000);
`

const DEFAULT_INDUSTRY_INSERT_SQL = `
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (1, '互联网', 0, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (2, '游戏', 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (3, '人工智能', 2, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (4, '软件', 3, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (5, '芯片', 4, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (6, '硬件', 5, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (7, '通信与硬件', 6, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (8, '电子与硬件', 7, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (9, '计算机与IT服务', 8, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (10, '金融', 9, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (11, '银行', 10, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (12, '证券与投资', 11, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (13, '保险', 12, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (14, '电商与零售', 13, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (15, '消费品', 14, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (16, '食品饮料', 15, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (17, '医疗健康', 16, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (18, '生物医药', 17, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (19, '汽车', 18, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (20, '新能源', 19, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (21, '制造业', 20, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (22, '化工与材料', 21, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (23, '建筑与房地产', 22, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (24, '家居与物业', 23, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (25, '物流与供应链', 24, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (26, '交通运输', 25, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (27, '航空航天', 26, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (28, '能源与矿业', 27, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (29, '电力与公用事业', 28, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (30, '教育', 29, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (31, '旅游与酒店', 30, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (32, '媒体与内容', 31, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (33, '广告与营销', 32, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (34, '文化娱乐', 33, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (35, '专业服务与咨询', 34, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (36, '法律服务', 35, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (37, '人力资源', 36, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (38, '农业与农牧', 37, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (39, '政府与公共服务', 38, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (40, '跨境贸易', 39, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (41, '生活服务', 40, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (42, '环保与循环经济', 41, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (43, '其他服务', 42, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (44, '林业与木材', 43, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (45, '渔业与水产', 44, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (46, '烟草', 45, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (47, '纺织与服装', 46, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (48, '化妆品与美容', 47, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (49, '珠宝与奢侈品', 48, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (50, '批发贸易', 49, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (51, '医疗器械', 50, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (52, '互联网安全', 51, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (53, '云计算与数据服务', 52, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (54, '物联网', 53, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (55, '机器人与智能制造', 54, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (56, '科研与技术服务', 55, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (57, '检验检测与认证', 56, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (58, '会计审计与税务', 57, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (59, '设计与创意', 58, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (60, '知识产权服务', 59, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (61, '安保服务', 60, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (62, '国防军工', 61, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (63, '轨道交通', 62, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (64, '港口航运与海洋', 63, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (65, '邮政与快递', 64, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (66, '航空服务与机场', 65, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (67, '核工业', 66, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (68, '石油与天然气', 67, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (69, '水务与水处理', 68, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (70, '餐饮', 69, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (71, '体育与健身', 70, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (72, '养老与社会工作', 71, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (73, '出版与印刷', 72, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (74, '影视与演艺', 73, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (75, '宠物与兽医', 74, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (76, '租赁服务', 75, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (77, '维修与保养', 76, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (78, '国际组织', 77, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (79, '非营利与社会组织', 78, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (80, '殡葬与生命服务', 79, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (81, '地质勘查与测绘', 80, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (82, '气象与海洋观测', 81, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO industries (id, name, sort_order, is_builtin, created_at, updated_at) VALUES (83, '招标采购与工程服务', 82, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
`
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
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version !== 0 && version !== DB_SCHEMA_VERSION) {
      throw new Error(`不支持的数据库结构版本：${version}，需要版本 ${DB_SCHEMA_VERSION}`)
    }

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
        career_url TEXT,
        last_read_at INTEGER,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_industries (
        company_id INTEGER NOT NULL,
        industry_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (company_id, industry_id)
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
        sort_order INTEGER NOT NULL,
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
        reminder_minutes INTEGER CHECK (reminder_minutes IS NULL OR reminder_minutes >= 0),
        is_completed INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_event_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calendar_event_id INTEGER NOT NULL,
        reminder_at INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        UNIQUE(calendar_event_id, reminder_at)
      );

      CREATE INDEX IF NOT EXISTS idx_opportunities_status_id ON opportunities(status_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_company_id ON opportunities(company_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_deadline_at ON opportunities(deadline_at);
      CREATE INDEX IF NOT EXISTS idx_opportunities_updated_at ON opportunities(updated_at);
      CREATE INDEX IF NOT EXISTS idx_company_industries_industry_id ON company_industries(industry_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events(start_at, end_at);
    `)

    if (version === 0) {
      this.seed()
      this.db.pragma(`user_version = ${DB_SCHEMA_VERSION}`)
    }
  }

  private seed(): void {
    const now = Date.now()
    const insertCompany = this.db.prepare(`
      INSERT INTO companies (name, career_url, is_builtin, is_favorite, created_at, updated_at)
      VALUES (?, ?, 1, 0, ?, ?)
      ON CONFLICT(name) DO UPDATE SET name = excluded.name
      RETURNING id
    `)
    const addIndustry = this.db.prepare(`
      INSERT OR IGNORE INTO company_industries (company_id, industry_id, created_at)
      VALUES (?, ?, ?)
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
      this.db.exec(DEFAULT_STATUS_INSERT_SQL)
      this.db.exec(DEFAULT_INDUSTRY_INSERT_SQL)
      removeGeneratedAliases.run()
      for (const companySeed of BUILTIN_COMPANIES) {
        const company = insertCompany.get(companySeed.name, companySeed.careerUrl, now, now) as { id: number }
        const companyId = company.id
        for (const industryId of companySeed.industryIds) addIndustry.run(companyId, industryId, now)
        for (const alias of companySeed.aliases) addAlias.run(companyId, alias, now)
      }
    })
    seedTransaction()
  }

}
