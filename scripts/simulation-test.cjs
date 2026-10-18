// 使用真实用户问题检验相关性、上下文和代码行为，不靠“回答够长”判定有效。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {simulate} = require('../main');
const checks=[];
const user=content=>({role:'user',content});
const assistant=content=>({role:'assistant',content});
const ask=(text,history=[])=>simulate([...history,user(text)]);
const check=(name,fn)=>{fn();checks.push(name);console.log('通过：'+name);};
const question='我想做过吃货地图的软件。你能帮我吗';
const initial=ask(question,[user('你好'),assistant('你好，有什么想聊的？')]);
const foodHistory=[user(question),assistant(initial)];
const originalFetch=global.fetch;let networkCalls=0;
global.fetch=()=>{networkCalls++;throw new Error('模拟测试禁止网络');};
try {
  check('截图原话包含店铺、地图、收藏，不引用“你好”或输出通用空话',()=>{
    assert.match(initial,/吃货地图/);assert.match(initial,/地图找店/);assert.match(initial,/收藏/);assert.match(initial,/评价|评分/);
    assert.doesNotMatch(initial,/延续刚才|提到的「你好」|最小的行动|已经知道的信息|时间、成本和预期收益/);
  });
  const web=ask('先做网页版',foodHistory);
  check('短追问承接吃货地图和店铺数据',()=>{assert.match(web,/网页版.*吃货地图/);assert.match(web,/经纬度/);assert.match(web,/收藏/);assert.doesNotMatch(web,/先先/);});
  const code=ask('代码呢',[...foodHistory,user('先做网页版'),assistant(web)]);
  check('项目里的“代码呢”返回店铺逻辑，不返回问候函数',()=>{assert.match(code,/filterShops/);assert.doesNotMatch(code,/function greet/);});
  check('生成的店铺筛选代码实际运行，按状态与菜系筛选且不修改输入',()=>{
    const source=code.match(/```javascript\n([\s\S]*?)```/)[1];
    const records=[{name:'甲',category:'面食',status:'想去'},{name:'乙',category:'面食',status:'去过'},{name:'丙',category:'甜品',status:'想去'}];
    const value=vm.runInNewContext(source+`\nconst inputRecords=${JSON.stringify(records)};JSON.stringify([filterShops(inputRecords,'面食'),filterShops(inputRecords),inputRecords])`,{console:{log(){}}},{timeout:1000});
    const [filtered,all,original]=JSON.parse(value);assert.deepEqual(filtered,[records[0]]);assert.deepEqual(all,[records[0],records[2]]);assert.deepEqual(original,records);
  });
  const mini=ask('先做微信小程序',foodHistory);
  check('选择小程序不会把“微信”误当成新的项目名称',()=>{assert.match(mini,/微信小程序.*吃货地图/);});
  const tech=ask('技术栈怎么选',[...foodHistory,user('先做微信小程序'),assistant(mini)]);
  check('技术追问记住小程序选择，而不是改回 HTML 网页',()=>{assert.match(tech,/WXML/);assert.match(tech,/WXSS/);assert.doesNotMatch(tech,/原生 HTML/);});
  check('排除被否定的平台，保留肯定选择',()=>{const reply=ask('不要小程序，先做网页版',foodHistory);assert.match(reply,/按网页版/);assert.doesNotMatch(reply,/按微信小程序/);});
  check('尊重第一版不登录的约束，并说明本机保存边界',()=>{const reply=ask('不用登录',foodHistory);assert.match(reply,/不做登录/);assert.match(reply,/本机/);assert.match(reply,/导出/);});
  check('不用地图时转成美食收藏清单',()=>{const reply=ask('先不做地图',foodHistory);assert.match(reply,/美食收藏清单/);assert.match(reply,/地图留到后面/);});
  check('不要代码时给业务功能，不塞代码块',()=>{const reply=ask('不要写代码，先说功能',foodHistory);assert.match(reply,/地图找店/);assert.doesNotMatch(reply,/```/);});
  check('零基础反馈优先给页面和操作步骤',()=>{const reply=ask('我不会写代码',foodHistory);assert.match(reply,/草图/);assert.doesNotMatch(reply,/```/);});
  check('更换为记账项目不串入店铺、地图或旧平台',()=>{
    const reply=ask('我现在想做一个记账软件',[...foodHistory,user('先做网页版'),assistant(web)]);
    assert.match(reply,/金额|收支|账单/);assert.doesNotMatch(reply,/吃货|店铺|地图/);
  });
  check('记账项目的代码按整数分汇总支出',()=>{
    const history=[user('我想做记账软件'),assistant('可以，先记一笔收支。')];const reply=ask('给我代码',history);
    const source=reply.match(/```javascript\n([\s\S]*?)```/)[1];
    const value=vm.runInNewContext(source+'\nJSON.stringify(totalExpenses([{type:"支出",category:"餐饮",cents:123},{type:"支出",category:"餐饮",cents:456},{type:"收入",category:"工资",cents:10000}]))',{}, {timeout:1000});
    assert.deepEqual(JSON.parse(value),{'餐饮':579});
  });
  check('明确换话题后，不从更早的美食需求续聊',()=>{
    const reply=ask('继续',[...foodHistory,user('我想学习 Python'),assistant('先安排基础练习。')]);assert.doesNotMatch(reply,/吃货|店铺|地图/);assert.match(reply,/Python/);
  });
  check('Python 是什么返回解释，不误触发代码',()=>{const reply=ask('Python是什么');assert.match(reply,/编程语言/);assert.doesNotMatch(reply,/```/);});
  check('学习 Python 返回学习安排，不误触发问候函数',()=>{const reply=ask('帮我制定学习 Python 的计划');assert.match(reply,/Python/);assert.match(reply,/练习/);assert.doesNotMatch(reply,/def greet|function greet/);});
  check('翻译意图不被“你好”关键词抢走',()=>{assert.match(ask('翻译你好'),/Hello/);assert.doesNotMatch(ask('翻译你好'),/想聊什么/);});
  check('排序代码实际按数字排序，输入保持不变',()=>{
    const reply=ask('用 JavaScript 写一个排序函数');const source=reply.match(/```javascript\n([\s\S]*?)```/)[1];
    const value=vm.runInNewContext(source+'\nconst input=[10,2,1];JSON.stringify([transform(input),input])',{console:{log(){}}},{timeout:1000});assert.deepEqual(JSON.parse(value),[[1,2,10],[10,2,1]]);
  });
  check('未知项目仍指向用户说的业务，而非伪造行业知识',()=>{const reply=ask('我想做一个宠物领养的软件');assert.match(reply,/宠物领养/);assert.match(reply,/给谁用/);});
  check('重复项目问题改为推进步骤，避免原样重复',()=>{const again=ask(question,foodHistory);assert.notEqual(again,initial);assert.match(again,/新增|准备数据/);});
  check('连续问候避免紧邻重复，同一轮不硬塞无关上下文',()=>{
    const history=[...foodHistory];let previous='';for(let i=0;i<30;i++){const reply=ask('你好',history);assert.notEqual(reply,previous);assert.doesNotMatch(reply,/延续刚才|吃货地图/);history.push(user('你好'),assistant(reply));previous=reply;}
  });
  check('对实时数据和超出词库的问题说明能力边界',()=>{assert.match(ask('今天天气怎么样'),/没有实时数据/);assert.match(ask('翻译一篇很长的陌生文章'),/不能可靠/);});
  check('全部模拟场景不触发网络请求',()=>{assert.equal(networkCalls,0);});
  const report={time:new Date().toISOString(),checks,networkCalls,example:{question,initial,followup:web,code,miniProgram:mini,technology:tech}};
  const folder=path.join(__dirname,'../work');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'simulation-results.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(folder,'simulation-examples.md'),`# Vesper 1.0.1 模拟回复改进样例\n\n## 用户\n\n${question}\n\n## 新回复\n\n${initial}\n\n## 用户：先做网页版\n\n${web}\n\n## 用户：代码呢\n\n${code}\n\n本地模拟仍是规则引擎，界面继续显示模拟模式及未连接真实模型。\n`);
  console.log(`全部 ${checks.length} 项模拟引擎检查通过。`);
} finally {global.fetch=originalFetch;}
