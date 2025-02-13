import {Context, h, Schema, Session} from 'koishi'
import {} from 'koishi-plugin-puppeteer'

import {marked} from 'marked';

export const name = 'ds-r-c'
export const inject = ['database', 'puppeteer']
export const usage = `## 使用

1. 设置指令别名。
2. 填写配置。
3. 发送 \`dsrc 创建房间\`。
4. 发送 \`房间名 文本\` 聊天。

## QQ 群

* 956758505`

// pz*
export interface Config {
  baseURL: string;
  apiKey: string;
  model: string; // [deepseek-chat, deepseek-reasoner]
  frequency_penalty: number; // >= -2 and <= 2
  max_tokens: number; // 介于 1 到 8192 间的整数
  presence_penalty: number; // >= -2 and <= 2
  temperature: number; // 介于 0 和 2 之间 我们通常建议可以更改这个值或者更改 top_p，但不建议同时对两者进行修改。
  top_p: number; // 介于 0 和 1 之间

  atReply: boolean;
  quoteReply: boolean;

  isLog: boolean
}

export const Config: Schema<Config> =
  Schema.intersect([
    Schema.object({
      baseURL: Schema.string().default('https://api.deepseek.com/v1'),
      apiKey: Schema.string(),
      model: Schema.string(),
      frequency_penalty: Schema.number().min(-2).max(2).default(0),
      max_tokens: Schema.number().min(1).max(8192).default(8192),
      presence_penalty: Schema.number().min(-2).max(2).default(0),
      temperature: Schema.number().min(0).max(2).default(1),
      top_p: Schema.number().min(0).max(1).default(1),
    }).description('API'),

    Schema.object({
      atReply: Schema
        .boolean()
        .default(false)
        .description('响应时 @'),
      quoteReply: Schema
        .boolean()
        .default(true)
        .description('响应时引用'),
    }).description('回复'),

    Schema.object({
      isLog: Schema
        .boolean()
        .default(false)
        .description('打印响应'),

    }).description('调试'),

  ])

// smb*
declare module 'koishi' {
  interface Tables {
    ds_r_c_room: Room;
  }
}

// jk*
interface Room {
  id: number;
  name: string;
  description: string;
  preset: string;
  master: string;
  isOpen: boolean;
  isWaiting: boolean;
  messages: Message[];
  msgId: string;
}

interface Message {
  role: string;
  content: string;
}

// l*
export async function apply(ctx: Context, cfg: Config) {
  // tzb*
  ctx.model.extend('ds_r_c_room', {
    id: 'unsigned',
    name: 'string',
    description: 'string',
    preset: 'string',
    master: 'string',
    isOpen: 'boolean',
    isWaiting: 'boolean',
    messages: {type: 'json', initial: []},
    msgId: 'string',
  }, {autoInc: true, primary: 'id'});

  // cl*
  const logger = ctx.logger('ds-r-c')
  const rooms = await ctx.database.get('ds_r_c_room', {});
  // bl*
  let roomNames = rooms.map(room => room.name);

  // zjj*
  ctx.middleware(async (session, next) => {
    const content = `${h.select(session.event.message.elements, 'text')}`;
    const {name: roomName, content: text} = extractNameAndContent(content);
    if (!text) {
      return await next();
    }
    if (!roomNames.includes(roomName)) {
      return await next();
    }
    const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
    const room = rooms[0];
    if (room.isWaiting) {
      return await next();
    }
    if (!room.isOpen && room.master !== session.userId) {
      return await next();
    }
    const messages = room.messages;
    if (messages.length === 0) {
      return await next();
    }

    messages.push({role: 'user', content: text})

    await ctx.database.set('ds_r_c_room', {
      name: roomName,
    }, {
      isWaiting: true,
      messages,
    })

    let reply = await chatCompletions(messages);

    if (!reply) {
      const msgId = await sendMsg(session, '请重试', true);
      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        isWaiting: false,
        msgId,
      });
      return
    }

    reply = removeContentBeforeLastThinkTag(reply);

    const buffer = await md2img(reply);
    const msgId = await sendMsg(session, `${roomName} ${messages.length}\n${h.image(buffer, 'image/png')}`, true)

    await ctx.database.set('ds_r_c_room', {
      name: roomName,
    }, {
      isWaiting: false,
      messages: [...messages, {role: 'assistant', content: reply}],
      msgId,
    });
  });

  // zl*
  ctx
    .command('dsrc')

  // cjfj*
  ctx
    .command('dsrc.创建房间 <roomName:string> <roomPreset:text>')
    .action(async ({session}, roomName, roomPreset) => {
      if (!roomName || !roomPreset) {
        return await sendMsg(session, `dsrc.创建房间 房间名 房间提示词

示例：
dsrc.创建房间 哮天犬 你是一只哮天犬`);
      }

      roomName = roomName.trim();

      if (roomName.length > 5) {
        return await sendMsg(session, '房间名不能超过 5 个字符');
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length !== 0) {
        return await sendMsg(session, '房间名已存在');
      }

      await ctx.database.create('ds_r_c_room', {
        name: roomName,
        preset: roomPreset,
        master: session.userId,
        isOpen: true,
        isWaiting: false,
        messages: [{role: 'system', content: roomPreset}],
        description: '',
      });

      roomNames.push(roomName);
      await sendMsg(session, `房间 ${roomName} 创建成功

操作示例：
${roomName} 你好啊
添加房间描述 ${roomName} 一只笨蛋呢
删除房间 ${roomName}
私有房间 ${roomName}
复制房间 ${roomName} 新房间名
...`);

    });

  // fzfj*
  ctx
    .command('dsrc.复制房间 <roomName:string> <newName:string>')
    .action(async ({session}, roomName, newName) => {
      if (!roomName || !newName) {
        return await sendMsg(session, `dsrc.复制房间 房间名 新房间名

示例：
dsrc.复制房间 哮天犬 大狗狗`);
      }

      newName = newName.trim();

      if (newName.length > 5) {
        return await sendMsg(session, '房间名不能超过 5 个字符');
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '原房间不存在');
      }

      const room = rooms[0];

      await ctx.database.create('ds_r_c_room', {
        name: newName,
        preset: room.preset,
        master: session.userId,
        isOpen: true,
        isWaiting: false,
        messages: [{role: 'system', content: room.preset}],
        description: room.description + '(复制)',
      });

      roomNames.push(newName);
      await sendMsg(session, `房间 ${newName} 创建成功

${newName} 拥有与 ${roomName} 相同的提示词和描述

操作示例：
${newName} 你好啊，今天天气怎么样？
...`);

    });

  // scfj*
  ctx
    .command('dsrc.删除房间 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.删除房间 房间名

示例：
dsrc.删除房间 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (rooms[0].master !== session.userId && !rooms[0].isOpen) {
        return await sendMsg(session, '只有房主可以操作');
      }

      await ctx.database.remove('ds_r_c_room', {
        name: roomName,
      });

      roomNames = roomNames.filter(name => name !== roomName);
      await sendMsg(session, `房间 ${roomName} 删除成功`);

    });

  // syfj*
  ctx
    .command('dsrc.私有房间 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.私有房间 房间名

示例：
dsrc.私有房间 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (rooms[0].master !== session.userId) {
        return await sendMsg(session, '只有房主可以操作');
      }
      await ctx.database.set('ds_r_c_room', {
          name: roomName,
        },
        {
          isOpen: false,
        });

      await sendMsg(session, `房间 ${roomName} 已私有

非你之外的人无法删除、修改、对话`);
    });

  // gkfj*
  ctx
    .command('dsrc.公开房间 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.公开房间 房间名

示例：
dsrc.公开房间 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (rooms[0].master !== session.userId) {
        return await sendMsg(session, '只有房主可以操作');
      }

      if (rooms[0].isOpen) {
        return await sendMsg(session, '房间公开');
      }

      await ctx.database.set('ds_r_c_room', {
          name: roomName,
        },
        {
          isOpen: true,
        });

      await sendMsg(session, `房间 ${roomName} 已公开`);
    });

  // fjlb*
  ctx
    .command('dsrc.房间列表')
    .action(async ({session}) => {
      const rooms = await ctx.database.get('ds_r_c_room', {});

      if (rooms.length === 0) {
        return await sendMsg(session, '没有房间');
      }

      const title = '# 房间列表\n\n| 房间名 | 描述 |\n| --- | --- |';
      const tableRows = rooms.map(room =>
        `| ${room.name}${room.isOpen ? '' : '(私有)'} | ${room.description ? room.description : '无'} |`
      ).join('\n');

      const msg = `${title}\n${tableRows}`;

      const buffer = await md2img(msg);
      await sendMsg(session, h.image(buffer, 'image/png'));
    });

  // ckfjys*
  ctx
    .command('dsrc.查看房间预设 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.查看房间预设 房间名

示例：
dsrc.查看房间预设 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const buffer = await md2img(rooms[0].preset);
      await sendMsg(session, h.image(buffer, 'image/png'))
    });

  // tjfjms*
  ctx
    .command('dsrc.添加房间描述 <roomName:string> <description:string>')
    .action(async ({session}, roomName, description) => {
      if (!roomName || !description) {
        return await sendMsg(session, `dsrc.添加房间描述 房间名 房间描述

示例：
dsrc.添加房间描述 哮天犬 二郎神的狗`);
      }

      if (roomName.length > 10) {
        return await sendMsg(session, '房间描述不能超过 10 个字符');
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        description,
      });

      await sendMsg(session, `房间 ${roomName} 描述已添加`);

    });

  // tzfjhf*
  ctx
    .command('dsrc.停止房间回复 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.停止房间回复 房间名

示例：
dsrc.停止房间回复 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (!rooms[0].isWaiting) {
        return await sendMsg(session, '回复已停止');
      }

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        isWaiting: false,
      });

      await sendMsg(session, `房间 ${roomName} 回复已停止`);

    });

  // xgfjys*
  ctx
    .command('dsrc.修改房间预设 <roomName:string> <newPreset:text>')
    .action(async ({session}, roomName, newPreset) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.修改房间预设 房间名 新预设

示例：
dsrc.修改房间预设 哮天犬 你现在是一条魅魔 m 属性哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (rooms[0].master !== session.userId && !rooms[0].isOpen) {
        return await sendMsg(session, '只有房主可以操作');
      }

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        preset: newPreset,
        messages: updateSystemMessageContent(rooms[0].messages, newPreset),
      });

      await sendMsg(session, `房间 ${roomName} 预设已修改`);
    });

  // xgfjm*
  ctx
    .command('dsrc.修改房间名 <roomName:string> <newName:text>')
    .action(async ({session}, roomName, newName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.修改房间名 房间名 新房间名

示例：
dsrc.修改房间名 哮天犬 大狗狗`);
      }

      newName = newName.trim();

      if (newName.length > 5) {
        return await sendMsg(session, '房间名不能超过 5 个字符');
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (rooms[0].master !== session.userId && !rooms[0].isOpen) {
        return await sendMsg(session, '只有房主可以操作');
      }

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        name: newName,
      });

      roomNames = roomNames.map(name => name === roomName ? newName : name);
      await sendMsg(session, `房间 ${roomName} 已修改为 ${newName}`);
    });

  // cxhf*
  ctx
    .command('dsrc.重新回复 <roomName:text>', {captureQuote: false})
    .action(async ({session}, roomName) => {
      if (!roomName && session.event.message.quote) {
        const quote = session.event.message.quote;
        const msgId = quote.id;
        const rooms = await ctx.database.get('ds_r_c_room', {msgId});
        if (rooms.length > 0) {
          roomName = rooms[0].name;
        }
      }
      if (!roomName) {
        return await sendMsg(session, `dsrc.重新回复 房间名

示例：
dsrc.重新回复 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      if (rooms[0].master !== session.userId && !rooms[0].isOpen) {
        return await sendMsg(session, '只有房主可以操作');
      }

      if (rooms[0].isWaiting) {
        return await sendMsg(session, '回复等待未结束 请先停止回复');
      }

      const room = rooms[0];
      const messages = room.messages;
      if (messages.length === 0) {
        return await sendMsg(session, '没有消息');
      }

      const messagesWithoutLastAssistant = deleteLastAssistantMessage(messages);

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        messages: messagesWithoutLastAssistant,
        isWaiting: true,
      });

      let content = await chatCompletions(messagesWithoutLastAssistant);
      if (!content) {
        const msgId = await sendMsg(session, '请重试', true);
        await ctx.database.set('ds_r_c_room', {
          name: roomName,
        }, {
          isWaiting: false,
          msgId,
        });
        return
      }

      content = removeContentBeforeLastThinkTag(content);

      const buffer = await md2img(content);
      const msgId = await sendMsg(session, `${roomName} ${messagesWithoutLastAssistant.length}\n${h.image(buffer, 'image/png')}`, true)

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        messages: [...messagesWithoutLastAssistant, {role: 'assistant', content}],
        isWaiting: false,
        msgId,
      });
    });

  // scqbfjdqbltjl*
  ctx
    .command('dsrc.删除全部房间的全部聊天记录')
    .action(async ({session}) => {
      const rooms = await ctx.database.get('ds_r_c_room', {});
      if (rooms.length === 0) {
        return await sendMsg(session, '无房间');
      }

      let failedRooms = [];
      let successRooms = [];
      for (const room of rooms) {
        if (room.isWaiting) {
          failedRooms.push(room.name);
          continue;
        }
        if (!room.isOpen && room.master !== session.userId) {
          failedRooms.push(room.name);
          continue;
        }

        await ctx.database.set('ds_r_c_room', {
          name: room.name,
        }, {
          messages: [{role: 'system', content: room.preset}],
        });

        successRooms.push(room.name);

      }

      return await sendMsg(session, `成功删除 ${successRooms.length} 个房间的聊天记录\n失败房间：${failedRooms.join(' ')}`);
    });

  // scmgfjdqbltjl*
  ctx
    .command('dsrc.删除某个房间的全部聊天记录 <roomName:text>', {captureQuote: false})
    .action(async ({session}, roomName) => {
      if (!roomName && session.event.message.quote) {
        const quote = session.event.message.quote;
        const msgId = quote.id;
        const rooms = await ctx.database.get('ds_r_c_room', {msgId});
        if (rooms.length > 0) {
          roomName = rooms[0].name;
        }
      }

      if (!roomName) {
        return await sendMsg(session, `dsrc.删除某个房间的全部聊天记录 房间名

示例：
dsrc.删除某个房间的全部聊天记录 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const room = rooms[0];
      if (room.isWaiting) {
        return await sendMsg(session, '回复等待未结束 请先停止回复');
      }

      if (!room.isOpen && room.master !== session.userId) {
        return await sendMsg(session, '只有房主可以操作');
      }

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        messages: [{role: 'system', content: room.preset}],
      });

      return await sendMsg(session, `成功删除 ${roomName} 的聊天记录`);
    });

  // scdtltjl*
  ctx
    .command('dsrc.删除多条聊天记录 <roomName:string> <indexes:text>')
    .action(async ({session}, roomName, indexes) => {
      if (!roomName || !indexes) {
        return await sendMsg(session, `dsrc.删除多条聊天记录 房间名 索引列表

示例：
dsrc.删除多条聊天记录 哮天犬 2、3、5
dsrc.删除多条聊天记录 哮天犬 2 3 5
dsrc.删除多条聊天记录 哮天犬 2,3,5`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const room = rooms[0];
      if (room.isWaiting) {
        return await sendMsg(session, '回复等待未结束 请先停止回复');
      }

      if (!room.isOpen && room.master !== session.userId) {
        return await sendMsg(session, '只有房主可以操作');
      }
      const messages = room.messages;
      //解析索引
      const indexList = indexes.split(/[\s,，、]+/).map(Number).filter(index => index >= 1 && index < messages.length);

      if (indexList.length === 0) {
        return await sendMsg(session, '索引超出范围');
      }
      // 倒序排列索引
      indexList.sort((a, b) => b - a);
      // 删除索引
      for (const index of indexList) {
        messages.splice(index, 1);
      }

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        messages,
      });

      return await sendMsg(session, `成功删除 ${roomName} 的 ${indexList.join('、')} 条聊天记录`);
    });

  // xgmtlrjl*
  ctx
    .command('dsrc.修改某条聊天记录 <roomName:string> <index:number> <msgContent:text>')
    .action(async ({session}, roomName, index, msgContent) => {
      if (!roomName || !index || !msgContent) {
        return await sendMsg(session, `dsrc.修改某条聊天记录 房间名 索引 新内容

示例：
dsrc.修改某条聊天记录 哮天犬 2 你好啊`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const room = rooms[0];
      if (room.isWaiting) {
        return await sendMsg(session, '回复等待未结束 请先停止回复');
      }

      if (!room.isOpen && room.master !== session.userId) {
        return await sendMsg(session, '只有房主可以操作');
      }

      const messages = room.messages;
      if (index < 1 || index >= messages.length) {
        return await sendMsg(session, '索引超出范围');
      }

      messages[index].content = msgContent;

      await ctx.database.set('ds_r_c_room', {
        name: roomName,
      }, {
        messages,
      });

      return await sendMsg(session, `成功修改 ${roomName} 的第 ${index} 条聊天记录`);
    });

  // ckmtltjl*
  ctx
    .command('dsrc.查看某条聊天记录 <roomName:string> <index:number>')
    .action(async ({session}, roomName, index) => {
      if (!roomName || !index) {
        return await sendMsg(session, `dsrc.查看某条聊天记录 房间名 索引

示例：
dsrc.查看某条聊天记录 哮天犬 2`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const room = rooms[0];

      const messages = room.messages;
      if (index < 1 || index >= messages.length) {
        return await sendMsg(session, '索引超出范围');
      }

      const buffer = await md2img(messages[index].content);
      await sendMsg(session, h.image(buffer, 'image/png'))
    });

  // ckmgfjdqbltjl*
  ctx
    .command('dsrc.查看某个房间的全部聊天记录 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.查看某个房间的全部聊天记录 房间名

示例：
dsrc.查看某个房间的全部聊天记录 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const room = rooms[0];
      const messages = room.messages;

      if (messages.length === 0) {
        return await sendMsg(session, '没有消息');
      }
      messages.splice(0, 1);

      const chunkSize = 10;
      const numChunks = Math.ceil(messages.length / chunkSize);

      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize;
        const end = start + chunkSize;
        const chunk = messages.slice(start, end);

        let msg = '';
        for (const [index, message] of chunk.entries()) {
          msg += `# ${start + index + 1} ${message.role}\n${message.content}\n\n\n---\n\n`;
        }

        try {
          const buffer = await md2img(msg);
          // await sendMsg(session, `正在发送第 ${i + 1} / ${numChunks} 组聊天记录...`);
          await sendMsg(session, h.image(buffer, 'image/png'));

        } catch (error) {
          logger.error(`Error processing chunk ${i + 1}:`, error);
          await sendMsg(session, `发送第 ${i + 1} 组聊天记录时出错: ${error.message || error}`);
          // break; // 中断循环
          // continue;  //继续
        }
      }
    });

  // ckmgfjdltjlgk*
  ctx
    .command('dsrc.查看某个房间的聊天记录概况 <roomName:string>')
    .action(async ({session}, roomName) => {
      if (!roomName) {
        return await sendMsg(session, `dsrc.查看某个房间的聊天记录概况 房间名

示例：
dsrc.查看某个房间的聊天记录概况 哮天犬`);
      }

      const rooms = await ctx.database.get('ds_r_c_room', {name: roomName});
      if (rooms.length === 0) {
        return await sendMsg(session, '房间不存在');
      }

      const room = rooms[0];
      const messages = room.messages;

      if (messages.length === 0) {
        return await sendMsg(session, '没有消息');
      }
      messages.splice(0, 1);

      const chunkSize = 25;
      const numChunks = Math.ceil(messages.length / chunkSize);

      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize;
        const end = start + chunkSize;
        const chunk = messages.slice(start, end);

        let msg = '';
        for (const [index, message] of chunk.entries()) {
          msg += `# ${index + 1} ${message.role}\n${truncateContent(message.content)}\n\n\n---\n\n`;
        }

        try {
          const buffer = await md2img(msg);
          // await sendMsg(session, `正在发送第 ${i + 1} / ${numChunks} 组聊天记录...`);
          await sendMsg(session, h.image(buffer, 'image/png'));

        } catch (error) {
          logger.error(`Error processing chunk ${i + 1}:`, error);
          await sendMsg(session, `发送第 ${i + 1} 组聊天记录时出错: ${error.message || error}`);
          // break; // 中断循环
          // continue;  //继续
        }
      }
    });

  // hs*
  function removeContentBeforeLastThinkTag(content: string): string {
    const lastThinkTagIndex = content.lastIndexOf("</think>");

    if (lastThinkTagIndex !== -1) {
      return content.substring(lastThinkTagIndex + "</think>".length).trim();
    } else {
      return content.trim();
    }
  }

  function generateBackgroundPattern(): string {
    return `
    background-image: linear-gradient(0deg, rgba(0,0,0,0.03) 1px, transparent 1px);
    background-size: 100% 2.5em;
  `;
  }

  function generateStyles(): string {
    const FONT_STYLES = {
      text: '"Source Sans Pro", sans-serif',
      heading: '"Source Sans Pro", sans-serif',
      sizes: {
        text: '30px',
        h1: '64px',
        h2: '52px',
        h3: '42px',
      },
      lineHeight: {
        text: '2.0',
        heading: '1.5',
      },
    } as const;

    const COLOR_PALETTE = {
      text: '#2d3748',
      textLight: '#718096',
      background: '#f9f9f9',
      surface: '#ffffff',
      accent: '#2563eb',
      border: '#e2e8f0',
      tableHover: '#f7fafc',
      tableHeader: '#edf2f7',
    } as const;

    const LAYOUT_SPACING = {
      paragraph: '2.5rem',
      section: '3rem',
      container: '5rem',
      tablePadding: '1rem',
    } as const;

    return `
    @import url('https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;700&display=swap');

    body {
      margin: 0;
      padding: 0;
      background-color: ${COLOR_PALETTE.surface};
      min-height: 100vh;
    }

    .poster-container {
      width: 100%;
      max-width: 800px;
      min-height: 98vh;
      margin: 1vh auto;
      padding: ${LAYOUT_SPACING.container};
      background-color: ${COLOR_PALETTE.background};
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.12);
      border-radius: 16px;
      ${generateBackgroundPattern()}
    }

    .poster-content {
      margin: 0 auto;
      font-family: ${FONT_STYLES.text};
      font-size: ${FONT_STYLES.sizes.text};
      line-height: ${FONT_STYLES.lineHeight.text};
      color: ${COLOR_PALETTE.text};
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      font-weight: 400;
    }

    .poster-content h1,
    .poster-content h2,
    .poster-content h3 {
      font-family: ${FONT_STYLES.heading};
      font-weight: 700;
      line-height: ${FONT_STYLES.lineHeight.heading};
      color: ${COLOR_PALETTE.text};
      letter-spacing: -0.02em;
    }

    .poster-content h1 {
      font-size: ${FONT_STYLES.sizes.h1};
      margin: 0 0 ${LAYOUT_SPACING.section};
    }

    .poster-content h2 {
      font-size: ${FONT_STYLES.sizes.h2};
      margin: ${LAYOUT_SPACING.section} 0 ${LAYOUT_SPACING.paragraph};
    }

    .poster-content h3 {
      font-size: ${FONT_STYLES.sizes.h3};
      margin: ${LAYOUT_SPACING.section} 0 ${LAYOUT_SPACING.paragraph};
    }

    .poster-content p {
      margin: 0 0 ${LAYOUT_SPACING.paragraph};
    }

    .poster-content a {
      color: ${COLOR_PALETTE.accent};
      text-decoration: none;
      border-bottom: 2px solid rgba(37, 99, 235, 0.3);
    }

    .poster-content strong {
      font-weight: 600;
      color: ${COLOR_PALETTE.text};
    }

    .poster-content em {
      font-style: italic;
      color: ${COLOR_PALETTE.textLight};
    }

    .poster-content blockquote {
      margin: ${LAYOUT_SPACING.section} 0;
      padding: 1.5em 2em;
      border-left: 4px solid ${COLOR_PALETTE.accent};
      background-color: rgba(37, 99, 235, 0.04);
      font-style: italic;
    }

    .poster-content code {
      font-family: "SFMono-Regular", Consolas, Menlo, monospace;
      font-size: 0.92em;
      background-color: rgba(0,0,0,0.04);
      padding: 0.2em 0.4em;
      border-radius: 4px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .poster-content pre {
      background-color: #1a1a1a;
      color: #ffffff;
      padding: 2em;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.92em;
      line-height: 1.6;
      white-space: pre-wrap;
      word-wrap: break-word;
      max-width: 100%;
    }
      .poster-content pre code {
        background-color: transparent;
        padding: 0;
        color: inherit;
    }

 .poster-content table {
      width: 100%;
      margin: ${LAYOUT_SPACING.section} 0;
      border-collapse: separate;
      border-spacing: 0;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      background-color: ${COLOR_PALETTE.surface};
    }

    .poster-content th {
      background-color: ${COLOR_PALETTE.tableHeader};
      color: ${COLOR_PALETTE.text};
      font-weight: 600;
      text-align: left;
      padding: ${LAYOUT_SPACING.tablePadding};
      border-bottom: 2px solid ${COLOR_PALETTE.border};
      position: relative;
      transition: background-color 0.2s ease;
    }

    .poster-content td {
      padding: ${LAYOUT_SPACING.tablePadding};
      border-bottom: 1px solid ${COLOR_PALETTE.border};
      color: ${COLOR_PALETTE.text};
      transition: background-color 0.2s ease;
    }

    .poster-content tr:last-child td {
      border-bottom: none;
    }

    .poster-content tbody tr:hover {
      background-color: ${COLOR_PALETTE.tableHover};
    }

    .poster-content th:not(:last-child),
    .poster-content td:not(:last-child) {
      border-right: 1px solid ${COLOR_PALETTE.border};
    }

    /* Responsive table support */
    @media (max-width: 768px) {
      .poster-content table {
        display: block;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .poster-content td,
      .poster-content th {
        white-space: nowrap;
      }
    }
  `;
  }

  async function markdownToPoster(markdown: string): Promise<string> {
    const htmlContent = await marked.parse(markdown);

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Poster</title>
        <style>${generateStyles()}</style>
      </head>
      <body>
        <div class="poster-container">
          <div class="poster-content">
            ${htmlContent}
          </div>
        </div>
      </body>
    </html>
  `;
  }

  function extractNameAndContent(text: string): { name: string; content: string } {
    const trimmedText = text.trim();
    const parts = trimmedText.split(' ');
    const name = parts[0];
    const content = parts.length > 1 ? parts.slice(1).join(" ") : "";

    return {name, content};
  }

  function truncateContent(content: string): string {
    if (content.length <= 100) {
      return content;
    } else {
      return content.substring(0, 100) + "...";
    }
  }

  async function chatCompletions(messages: Message[]): Promise<string> {
    const data = JSON.stringify({
      messages: messages,
      model: cfg.model,
      frequency_penalty: cfg.frequency_penalty,
      max_tokens: cfg.max_tokens,
      presence_penalty: cfg.presence_penalty,
      response_format: {
        type: "text",
      },
      stop: null,
      stream: false,
      stream_options: null,
      temperature: cfg.temperature,
      top_p: cfg.top_p,
      tools: null,
      tool_choice: "none",
      logprobs: false,
      top_logprobs: null,
    });

    const config = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: data,
    };

    try {
      const response = await fetch(`${removeTrailingSlash(cfg.baseURL)}/chat/completions`, config);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} - ${response.statusText}`);
      }

      const responseData = await response.json();
      const content = responseData.choices[0].message.content;
      if (cfg.isLog) {
        logger.info(content);
      }
      return content;
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      } else {
        logger.error(error);
      }
    }
  }

  function removeTrailingSlash(baseURL: string): string {
    baseURL = baseURL.trim()

    if (baseURL.endsWith('/')) {
      return baseURL.slice(0, -1);
    } else {
      return baseURL;
    }
  }

  function updateSystemMessageContent(messages: Message[], newPreset: string): Message[] {
    if (messages.length === 0) {
      return [{role: 'system', content: newPreset}];
    }

    for (const message of messages) {
      if (message.role === 'system') {
        message.content = newPreset;
        return messages;
      }
    }

    return messages;
  }

  function deleteLastAssistantMessage(messages: Message[]): Message[] {
    if (messages.length === 0) {
      return messages;
    }

    const lastMessage = messages[messages.length - 1];

    if (lastMessage.role === 'user') {
      return messages;
    } else if (lastMessage.role === 'assistant') {
      // messages.pop(); // 删除最后一个元素, pop会改变原数组
      // return messages;
      return messages.slice(0, -1); // 返回除最后一个元素外的新数组
    } else {
      return messages;
    }
  }

  async function md2img(markdown: string) {
    const html = await markdownToPoster(markdown);
    const page = await ctx.puppeteer.page()
    await page.setContent(html)
    await page.bringToFront()
    await page.setViewport({width: 800, height: 400});
    const buffer = await page.screenshot({fullPage: true});
    await page.close();
    return buffer;
  }

  async function sendMsg(session: Session, msg: any, isReturnMsgId = false) {
    if (cfg.atReply) {
      msg = `${h.at(session.userId)}${h('p', '')}${msg}`;
    }

    if (cfg.quoteReply) {
      msg = `${h.quote(session.messageId)}${msg}`;
    }

    const [msgId] = await session.send(msg);
    if (isReturnMsgId) {
      return msgId;
    }
  }

}

