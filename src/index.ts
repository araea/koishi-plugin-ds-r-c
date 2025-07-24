import { Context, h, Schema, Session, Command } from "koishi";
import {} from "koishi-plugin-puppeteer";
import { marked } from "marked";
import extract from "png-chunks-extract";
import PNGtext from "png-chunk-text";
import { Buffer } from "node:buffer";

export const name = "ds-r-c";
export const inject = ["database", "puppeteer"];
export const usage = `## 使用

1. 启动 \`pptr\` 和 \`数据库\` 服务。
2. 设置指令别名 (没看到指令，重启 commands 插件)。
3. 填写配置 (第三方 API，baseURL 最后加上 /v1)。
4. 发送 \`dsrc 创建房间\`。
5. 发送 \`房间名 文本\` 聊天。

## 特性

* 引用回复 \`房间\` 最后一条响应，可：
  * 触发 \`删除某个房间的全部聊天记录\`, \`重新回复\` 操作该 \`房间\`。
  * 消息结尾增加两个及以上空格，可直接继续聊天。
  * 如果消息以四个或以上空格结尾，则不会将消息转换为图片。

## QQ 群

* 956758505`;

// --- 配置 (Config) ---

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  frequency_penalty: number;
  max_tokens: number;
  presence_penalty: number;
  temperature: number;
  top_p: number;
  atReply: boolean;
  quoteReply: boolean;
  removeThinkBlock: boolean;
  theme: "light" | "black-gold";
  isLog: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    baseURL: Schema.string()
      .default("https://api.deepseek.com/v1")
      .description("API 地址"),
    apiKey: Schema.string().role("secret").required().description("API 密钥"),
    model: Schema.string()
      .default("deepseek-chat")
      .description("使用的模型，例如 `deepseek-chat` 或 `deepseek-coder`。"),
    frequency_penalty: Schema.number()
      .min(-2)
      .max(2)
      .default(0)
      .description("频率惩罚，介于 -2 和 2 之间。"),
    max_tokens: Schema.number()
      .min(1)
      .max(8192)
      .default(8192)
      .description("最大生成令牌数，介于 1 和 8192 之间。"),
    presence_penalty: Schema.number()
      .min(-2)
      .max(2)
      .default(0)
      .description("存在惩罚，介于 -2 和 2 之间。"),
    temperature: Schema.number()
      .min(0)
      .max(2)
      .default(1)
      .description("温度，介于 0 和 2 之间，控制随机性。"),
    top_p: Schema.number()
      .min(0)
      .max(1)
      .default(1)
      .description(
        "核心采样，介于 0 和 1 之间。不建议与 temperature 同时修改。"
      ),
  }).description("API 设置"),

  Schema.object({
    atReply: Schema.boolean().default(false).description("响应时是否 @ 用户。"),
    quoteReply: Schema.boolean()
      .default(true)
      .description("响应时是否引用用户消息。"),
    removeThinkBlock: Schema.boolean()
      .default(false)
      .description("是否在生成的回复中删除 `<think>` 思考过程块。"),
  }).description("回复设置"),

  Schema.object({
    theme: Schema.union(["light", "black-gold"])
      .default("black-gold")
      .description("选择生成图片的色彩主题。为您特别准备了「黑金」主题哦~"),
  }).description("外观设置"),

  Schema.object({
    isLog: Schema.boolean()
      .default(false)
      .description("是否在控制台打印完整的 API 响应内容。"),
  }).description("调试设置"),
]);

// --- 数据库与类型定义 (Database & Types) ---

declare module "koishi" {
  interface Tables {
    ds_r_c_room: Room;
  }
}

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
  role: "system" | "user" | "assistant";
  content: string;
}

export function apply(ctx: Context, cfg: Config) {
  const logger = ctx.logger(name);

  ctx.model.extend(
    "ds_r_c_room",
    {
      id: "unsigned",
      name: "string",
      description: "string",
      preset: "string",
      master: "string",
      isOpen: "boolean",
      isWaiting: "boolean",
      messages: { type: "json", initial: [] },
      msgId: "string",
    },
    { autoInc: true, primary: "id", unique: ["name"] }
  );

  // --- Services (服务层：API 通信、图片渲染) ---

  async function chatCompletions(messages: Message[]): Promise<string | null> {
    const data = JSON.stringify({
      messages,
      model: cfg.model,
      frequency_penalty: cfg.frequency_penalty,
      max_tokens: cfg.max_tokens,
      presence_penalty: cfg.presence_penalty,
      temperature: cfg.temperature,
      top_p: cfg.top_p,
      stream: false,
    });

    try {
      const response = await ctx.http.post(
        `${cfg.baseURL.replace(/\/$/, "")}/chat/completions`,
        data,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
        }
      );
      const content = response.choices[0]?.message?.content;
      if (!content) {
        logger.warn("API did not return a valid message content.", response);
        return null;
      }
      if (cfg.isLog) {
        logger.info(JSON.stringify(response, null, 2));
      }
      return content;
    } catch (error) {
      logger.error("Failed to fetch from DeepSeek API:", error);
      return null;
    }
  }

  async function md2img(markdown: string): Promise<Buffer> {
    const html = await markdownToPoster(markdown, cfg.theme);
    const page = await ctx.puppeteer.page();
    try {
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.setViewport({ width: 800, height: 100 });
      await page.bringToFront();
      const buffer = await page.screenshot({ fullPage: true });
      return buffer;
    } finally {
      await page.close();
    }
  }

  // --- Helpers (辅助函数) --
  //
  /**
   * --- 新增：解析角色卡 ---
   * 从图片URL中解析SillyTavern角色卡数据。
   * @param imageUrl 图片的URL
   * @returns 解析出的角色数据对象，失败则返回null
   */
  async function parseCharacterCard(imageUrl: string): Promise<any | null> {
    try {
      const imageBuffer = await ctx.http.get(imageUrl, {
        responseType: "arraybuffer",
      });
      const buffer = Buffer.from(imageBuffer);

      // 核心逻辑借鉴自 character-card-parser.js 的 read() 函数
      const chunks = extract(new Uint8Array(buffer));
      const textChunks = chunks
        .filter((chunk) => chunk.name === "tEXt")
        .map((chunk) => PNGtext.decode(chunk.data));

      if (textChunks.length === 0) {
        logger.warn("角色卡解析错误：在PNG元数据中未找到任何文本块。");
        return null;
      }

      // 优先使用 V3 (ccv3)
      const ccv3Chunk = textChunks.find(
        (chunk) => chunk.keyword.toLowerCase() === "ccv3"
      );
      if (ccv3Chunk) {
        const jsonData = Buffer.from(ccv3Chunk.text, "base64").toString("utf8");
        return JSON.parse(jsonData);
      }

      // 降级使用 V2 (chara)
      const charaChunk = textChunks.find(
        (chunk) => chunk.keyword.toLowerCase() === "chara"
      );
      if (charaChunk) {
        const jsonData = Buffer.from(charaChunk.text, "base64").toString(
          "utf8"
        );
        return JSON.parse(jsonData);
      }

      logger.warn('角色卡解析错误：未找到 "chara" 或 "ccv3" 数据块。');
      return null;
    } catch (error) {
      logger.error("解析角色卡时发生意外错误:", error);
      return null;
    }
  }

  async function findRoomByName(name: string): Promise<Room | null> {
    if (!name) return null;
    const rooms = await ctx.database.get("ds_r_c_room", { name });
    return rooms[0] || null;
  }

  function checkRoomPermission(room: Room, session: Session): boolean {
    return room.isOpen || room.master === session.userId;
  }

  async function getRoomNameFromQuote(
    session: Session
  ): Promise<string | null> {
    const quoteId = session.quote?.id;
    if (!quoteId) return null;
    const rooms = await ctx.database.get("ds_r_c_room", { msgId: quoteId });
    return rooms[0]?.name || null;
  }

  async function sendReply(
    session: Session,
    content: h.Fragment,
    returnId: true
  ): Promise<string>;
  async function sendReply(
    session: Session,
    content: h.Fragment,
    returnId?: false
  ): Promise<void>;
  async function sendReply(
    session: Session,
    content: h.Fragment,
    returnId: boolean = false
  ): Promise<string | void> {
    let elements = h.normalize(content);
    if (cfg.atReply) {
      elements = [h.at(session.userId), ...elements];
    }
    if (cfg.quoteReply) {
      elements = [h.quote(session.messageId), ...elements];
    }
    const [msgId] = await session.send(elements);
    if (returnId) {
      return msgId;
    }
  }

  const handleRoomCommand = (
    command: Command,
    callback: (
      session: Session,
      room: Room,
      options: any,
      ...args: any[]
    ) => Promise<string | void | h.Fragment>
  ) => {
    command.action(async ({ session, args, options }) => {
      let [roomName, ...restArgs] = args;

      // 核心功能：如果 roomName 未提供，且有引用消息，则尝试从中获取
      if (!roomName && session.quote) {
        roomName = await getRoomNameFromQuote(session);
      }

      // 如果最终还是没有 roomName，提示用户查看帮助
      if (!roomName) return session.execute(`${command.name} -h`);

      const room = await findRoomByName(roomName);
      if (!room) return `房间「${roomName}」不存在。`;

      if (!checkRoomPermission(room, session))
        return `你没有权限操作私有房间「${roomName}」。`;

      if (
        room.isWaiting &&
        (command.name.includes("回复") || command.name.includes("记录"))
      )
        return `房间「${roomName}」正在回复中，请稍后再试或使用 \`停止房间回复\` 指令。`;

      const result = await callback(session, room, options, ...restArgs);
      if (result) return sendReply(session, h.normalize(result));
    });
  };

  // --- Middleware & Commands ---

  ctx.middleware(async (session, next) => {
    const content = session.content;

    if (session.quote) {
      const roomName = await getRoomNameFromQuote(session);
      if (roomName) {
        if (["清空", "清空记录"].includes(content)) {
          return session.execute(`dsrc.清空 ${roomName}`);
        }
        if (["重新回复", "重说"].includes(content)) {
          return session.execute(`dsrc.重新回复 ${roomName}`);
        }
      }
    }

    const match = content.match(/^(\S+)\s+([\s\S]+)/);
    let roomName: string, text: string;
    if (match) {
      [, roomName, text] = match;
      text = text.trim();
    } else if (session.quote && content.endsWith("  ")) {
      roomName = await getRoomNameFromQuote(session);
      text = content.trim();
    } else {
      return next();
    }
    if (!text || !roomName) return next();
    const room = await findRoomByName(roomName);
    if (!room || !checkRoomPermission(room, session) || room.isWaiting) {
      return next();
    }
    const forceTextOutput = content.endsWith("    ");
    const newMessages: Message[] = [
      ...room.messages,
      { role: "user", content: text },
    ];
    let reply = await chatCompletions(newMessages);
    if (!reply) {
      await ctx.database.set(
        "ds_r_c_room",
        { id: room.id },
        { isWaiting: false }
      );
      return sendReply(session, "API 请求失败，请检查配置或稍后重试。");
    }

    // 根据配置项决定是否删除 <think> 块
    if (cfg.removeThinkBlock) {
      const thinkTagIndex = reply.lastIndexOf("</think>");
      if (thinkTagIndex !== -1) {
        reply = reply.substring(thinkTagIndex + "</think>".length).trim();
      }
    }

    let msgId: string;
    const replyHeader = `${room.name} (${newMessages.length})`;
    if (forceTextOutput) {
      msgId = await sendReply(session, `${replyHeader}\n\n${reply}`, true);
    } else {
      const buffer = await md2img(reply);
      msgId = await sendReply(
        session,
        h("p", `${replyHeader}\n`, h.image(buffer, "image/png")),
        true
      );
    }
    await ctx.database.set(
      "ds_r_c_room",
      { id: room.id },
      {
        isWaiting: false,
        messages: [...newMessages, { role: "assistant", content: reply }],
        msgId,
      }
    );
  });

  const dsrc = ctx.command("dsrc", "DeepSeek 聊天室插件");

  dsrc
    .subcommand(".创建 <name:string> <preset:text>", "创建新聊天房间")
    .example("dsrc.创建 翻译官 你是一个专业的翻译官")
    .action(async ({ session }, name, preset) => {
      if (!name || !preset) return session.execute("dsrc.创建 -h");
      if (name.length > 10) return "房间名不能超过 10 个字符。";
      if (await findRoomByName(name)) return `房间「${name}」已存在。`;
      await ctx.database.create("ds_r_c_room", {
        name,
        preset,
        master: session.userId,
        isOpen: true,
        isWaiting: false,
        messages: [{ role: "system", content: preset }],
        description: "",
        msgId: "",
      });
      return `房间「${name}」创建成功！\n开始对话：${name} 你好`;
    });

  dsrc
    .subcommand(".卡片创建", "通过图片角色卡创建房间")
    .usage(
      "发送指令并附上一张角色卡图片，即可创建新房间。\n例如：dsrc.卡片创建 [图片]"
    )
    .action(async ({ session }) => {
      const imageElement = h.select(session.elements, "img")[0];

      if (!imageElement) {
        return "请在发送指令时附上一张角色卡图片。";
      }

      const imageUrl = imageElement.attrs.src;
      if (!imageUrl) {
        return "无法获取图片地址，请重试。";
      }

      await session.send("正在解析角色卡，请稍候...");

      const characterData = await parseCharacterCard(imageUrl);

      if (!characterData) {
        return "图片解析失败，请确认上传的是有效的 SillyTavern 角色卡。";
      }

      // 从角色卡数据中提取信息
      const name = characterData.name?.trim();
      const description = characterData.description;
      const personality = characterData.personality;
      const first_mesg = characterData.first_mesg;
      const mes_example = characterData.mes_example;

      if (!name) {
        return "角色卡解析成功，但未找到角色名称 (name)。";
      }
      if (name.length > 10)
        return `角色卡中的名称「${name}」超过 10 个字符，无法创建。`;
      if (await findRoomByName(name)) return `房间「${name}」已存在。`;

      // 将角色信息整合成一个Markdown格式的预设
      let preset = `请你代入以下角色设定，并以第一人称进行对话。\n\n---\n\n`;
      if (description) preset += `## 人物描述\n${description}\n\n`;
      if (personality) preset += `## 性格特点\n${personality}\n\n`;
      if (first_mesg) preset += `## 开场白\n${first_mesg}\n\n`;
      if (mes_example)
        preset += `## 对话示例\n${mes_example.replace(
          /<START>/g,
          "---\n"
        )}\n\n`;

      // 创建房间
      await ctx.database.create("ds_r_c_room", {
        name,
        preset,
        master: session.userId,
        isOpen: true,
        isWaiting: false,
        messages: [{ role: "system", content: preset }],
        description: description?.substring(0, 20) || "由角色卡创建",
        msgId: "",
      });

      // 发送创建成功的带预览图的消息
      const presetPreview = `# ${name}\n\n**房主:** ${h.at(
        session.userId
      )}\n\n---\n\n${preset}`;
      const buffer = await md2img(presetPreview);
      await session.send(
        h("p", `房间「${name}」创建成功！`, h.image(buffer, "image/png"))
      );

      return `现在可以开始对话了：\n${name} 你好`;
    });

  handleRoomCommand(
    dsrc.subcommand(".删除 [name:string]", "删除一个聊天房间"),
    async (session, room, options) => {
      // 回调函数签名统一增加 options
      if (room.master !== session.userId) return "只有房主才能删除房间。";
      await ctx.database.remove("ds_r_c_room", { id: room.id });
      return `房间「${room.name}」已成功删除。`;
    }
  );

  handleRoomCommand(
    dsrc.subcommand(".设为私有 [name:string]", "将房间设为仅房主可用"),
    async (session, room, options) => {
      if (room.master !== session.userId) return "只有房主才能将房间设为私有。";
      if (!room.isOpen) return `房间「${room.name}」已经是私有状态。`;
      await ctx.database.set("ds_r_c_room", { id: room.id }, { isOpen: false });
      return `房间「${room.name}」已设为私有。`;
    }
  );

  handleRoomCommand(
    dsrc.subcommand(".设为公开 [name:string]", "将房间设为所有人可用"),
    async (session, room, options) => {
      if (room.master !== session.userId) return "只有房主才能将房间设为公开。";
      if (room.isOpen) return `房间「${room.name}」已经是公开状态。`;
      await ctx.database.set("ds_r_c_room", { id: room.id }, { isOpen: true });
      return `房间「${room.name}」已设为公开。`;
    }
  );

  dsrc
    .subcommand(".列表", "查看所有可用房间列表")
    .action(async ({ session }) => {
      const rooms = await ctx.database.get("ds_r_c_room", {});
      if (rooms.length === 0) return "当前没有任何房间。";
      rooms.sort((a, b) =>
        a.isOpen !== b.isOpen
          ? a.isOpen
            ? -1
            : 1
          : new Intl.Collator("zh-CN").compare(a.name, b.name)
      );
      const title = "# 房间列表\n\n| 房间名 | 描述 |\n| :--- | :--- |";
      const tableRows = rooms
        .map(
          (room) =>
            `| ${room.name}${room.isOpen ? "" : " (私有)"} | ${
              room.description || "无"
            } |`
        )
        .join("\n");
      const buffer = await md2img(`${title}\n${tableRows}`);
      return h.image(buffer, "image/png");
    });

  handleRoomCommand(
    dsrc
      .subcommand(".预设 [name:string]", "查看房间的系统预设")
      .option("text", "-t  获取纯文本格式的预设内容")
      .example("dsrc.预设 翻译官 -t"),
    async (session, room, options) => {
      // 房间查找和权限检查已由 handleRoomCommand 完成
      if (options.text) {
        return `房间「${room.name}」的预设内容如下：\n\n${room.preset}`;
      } else {
        const buffer = await md2img(
          `# ${room.name} 的预设\n\n---\n\n${room.preset}`
        );
        return h.image(buffer, "image/png");
      }
    }
  );

  handleRoomCommand(
    dsrc.subcommand(
      ".修改预设 [name:string] <preset:text>",
      "修改房间的系统预设"
    ),
    async (session, room, options, preset) => {
      if (!preset) return session.execute("dsrc.修改预设 -h");
      if (room.master !== session.userId) return "只有房主才能修改预设。";
      const newMessages = room.messages.map((m) =>
        m.role === "system" ? { ...m, content: preset } : m
      );
      await ctx.database.set(
        "ds_r_c_room",
        { id: room.id },
        { preset, messages: newMessages }
      );
      return `房间「${room.name}」的预设已更新。`;
    }
  );

  handleRoomCommand(
    dsrc.subcommand(
      ".修改描述 [name:string] <desc:text>",
      "修改房间的描述信息"
    ),
    async (session, room, options, desc) => {
      if (!desc) return session.execute("dsrc.修改描述 -h");
      if (desc.length > 20) return "描述不能超过 20 个字符。";
      if (room.master !== session.userId) return "只有房主才能修改描述。";
      await ctx.database.set(
        "ds_r_c_room",
        { id: room.id },
        { description: desc }
      );
      return `房间「${room.name}」的描述已更新。`;
    }
  );

  // --- Conversation history commands ---

  handleRoomCommand(
    dsrc.subcommand(".清空 <name:string>", "清空指定房间的聊天记录"),
    async (session, room) => {
      await ctx.database.set(
        "ds_r_c_room",
        { id: room.id },
        { messages: [{ role: "system", content: room.preset }] }
      );
      return `房间「${room.name}」的聊天记录已清空。`;
    }
  );

  dsrc
    .subcommand(".清空所有", "清空所有你有权限操作的房间的聊天记录", {
      authority: 2,
    })
    .option("confirm", "-c  确认执行此操作")
    .action(async ({ session, options }) => {
      if (!options.confirm)
        return "这是一个危险操作，会清空所有您有权限操作的房间的聊天记录。如果确认，请添加 -c 或 --confirm 选项再次执行。";
      const allRooms = await ctx.database.get("ds_r_c_room", {});
      let successCount = 0;
      let skippedCount = 0;
      for (const room of allRooms) {
        if (checkRoomPermission(room, session) && !room.isWaiting) {
          await ctx.database.set(
            "ds_r_c_room",
            { id: room.id },
            { messages: [{ role: "system", content: room.preset }] }
          );
          successCount++;
        } else {
          skippedCount++;
        }
      }
      return `操作完成。成功清空 ${successCount} 个房间的聊天记录，跳过 ${skippedCount} 个无权限或正在等待响应的房间。`;
    });

  handleRoomCommand(
    dsrc.subcommand(".重新回复 [name:string]", "让机器人重新生成最后一条回复"),
    async (session, room, options) => {
      if (room.messages.length <= 1) return "没有可重新生成的回复。";
      const messagesToResend = room.messages.slice(0, -1);
      await ctx.database.set(
        "ds_r_c_room",
        { id: room.id },
        { isWaiting: true, messages: messagesToResend }
      );
      let reply = await chatCompletions(messagesToResend);
      if (!reply) {
        await ctx.database.set(
          "ds_r_c_room",
          { id: room.id },
          { isWaiting: false }
        );
        return "API 请求失败，无法重新回复。";
      }
      if (cfg.removeThinkBlock) {
        const thinkTagIndex = reply.lastIndexOf("</think>");
        if (thinkTagIndex !== -1) {
          reply = reply.substring(thinkTagIndex + "</think>".length).trim();
        }
      }
      const buffer = await md2img(reply);
      const msgId = await sendReply(
        session,
        h(
          "p",
          `${room.name} (${messagesToResend.length}) (重)\n`,
          h.image(buffer, "image/png")
        ),
        true
      );
      await ctx.database.set(
        "ds_r_c_room",
        { id: room.id },
        {
          isWaiting: false,
          messages: [
            ...messagesToResend,
            { role: "assistant", content: reply },
          ],
          msgId,
        }
      );
    }
  );

  handleRoomCommand(
    dsrc.subcommand(
      ".修改记录 [name:string] <index:number> <content:text>",
      "修改指定房间的某条聊天记录"
    ),
    async (session, room, options, index, content) => {
      if (room.master !== session.userId) return "只有房主才能修改记录。";
      if (index === undefined || !content)
        return session.execute("dsrc.修改记录 -h");
      const messages = room.messages;
      if (index < 1 || index >= messages.length)
        return `索引无效。请输入 1 到 ${messages.length - 1} 之间的数字。`;
      messages[index].content = content;
      await ctx.database.set("ds_r_c_room", { id: room.id }, { messages });
      return `房间「${room.name}」的第 ${index} 条记录已成功修改。`;
    }
  );

  handleRoomCommand(
    dsrc.subcommand(
      ".删除记录 [name:string] <indexes:text>",
      "删除指定房间的单条或多条聊天记录"
    ),
    async (session, room, options, indexes) => {
      if (room.master !== session.userId) return "只有房主才能删除记录。";
      if (!indexes) return session.execute("dsrc.删除记录 -h");
      const messages = room.messages;
      const maxIndex = messages.length - 1;
      const indicesToDelete = indexes
        .split(/[\s,，、]+/)
        .map(Number)
        .filter((n) => !isNaN(n) && n >= 1 && n <= maxIndex)
        .sort((a, b) => b - a);
      if (indicesToDelete.length === 0)
        return `未提供有效索引。请输入 1 到 ${maxIndex} 之间的数字。`;
      const uniqueIndices = [...new Set(indicesToDelete)];
      for (const index of uniqueIndices) {
        messages.splice(Number(index), 1);
      }
      await ctx.database.set("ds_r_c_room", { id: room.id }, { messages });
      return `房间「${room.name}」的第 ${uniqueIndices
        .reverse()
        .join(", ")} 条记录已删除。`;
    }
  );

  handleRoomCommand(
    dsrc.subcommand(".历史 [name:string]", "以图片形式查看房间的聊天历史"),
    async (session, room, options) => {
      const messages = room.messages.slice(1);
      if (messages.length === 0) return "该房间还没有聊天记录。";
      const chunkSize = 15;
      const numChunks = Math.ceil(messages.length / chunkSize);
      await sendReply(
        session,
        `正在生成「${room.name}」的聊天历史记录（共 ${messages.length} 条，分 ${numChunks} 张图）...`
      );
      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize;
        const end = start + chunkSize;
        const chunk = messages.slice(start, end);
        let msgContent = chunk
          .map(
            (msg, index) =>
              `## ${start + index + 1}. ${
                msg.role === "user" ? "👤 User" : "🤖 Assistant"
              }\n\n${msg.content}`
          )
          .join("\n\n---\n\n");
        try {
          const buffer = await md2img(msgContent);
          await session.send(h.image(buffer, "image/png"));
        } catch (error) {
          logger.error(`Error sending history chunk ${i + 1}:`, error);
          await sendReply(session, `发送第 ${i + 1} 组聊天记录时出错。`);
        }
      }
    }
  );

  // --- Theming & Styling ---

  function getThemeStyles(theme: "light" | "black-gold"): string {
    const FONT_STYLES = `font-family: "Source Sans Pro", "Noto Sans SC", sans-serif;`;

    if (theme === "black-gold") {
      return `
        @import url('https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;700&family=Noto+Sans+SC:wght@400;700&display=swap');
        :root {
          --bg-color: #1a1a1a;
          --surface-color: #2c2c2c;
          --primary-text-color: #e8e6e3;
          --secondary-text-color: #b0b0b0;
          --accent-color: #ffd700; /* Vibrant Gold */
          --border-color: #444;
          --code-bg: #222;
        }
        body { background-color: var(--bg-color); color: var(--primary-text-color); ${FONT_STYLES} line-height: 1.8; font-size: 20px; padding: 3rem; margin: 0; }
        h1, h2, h3, h4, h5, h6 { ${FONT_STYLES} color: var(--accent-color); font-weight: 700; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5em; margin-top: 1.5em; text-shadow: 0 0 5px rgba(255, 215, 0, 0.3); }
        p { margin-bottom: 1.2em; }
        a { color: var(--accent-color); text-decoration: none; font-weight: 600; }
        strong { color: var(--accent-color); }
        blockquote { border-left: 4px solid var(--accent-color); background-color: var(--surface-color); padding: 1em 1.5em; margin: 1.5em 0; color: var(--secondary-text-color); font-style: italic; }
        code { background-color: var(--code-bg); padding: 0.2em 0.4em; border-radius: 4px; font-family: "Fira Code", monospace; font-size: 0.9em; border: 1px solid var(--border-color); }
        pre { background-color: var(--code-bg); color: #abb2bf; padding: 1.5em; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; border: 1px solid var(--border-color); }
        pre code { background-color: transparent; padding: 0; border: none; }
        table { width: 100%; border-collapse: collapse; margin: 1.5em 0; background-color: var(--surface-color); border: 1px solid var(--border-color); }
        th, td { border: 1px solid var(--border-color); padding: 0.8em 1em; text-align: left; }
        th { background-color: var(--bg-color); color: var(--accent-color); font-weight: bold; }
        hr { border: 0; border-top: 1px solid var(--border-color); margin: 2em 0; }
      `;
    }

    return `
      @import url('https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;700&family=Noto+Sans+SC:wght@400;700&display=swap');
      body { margin: 0; padding: 3.5rem; background-color: #f7f9fc; ${FONT_STYLES} font-size: 20px; line-height: 1.8; color: #333; }
      h1,h2,h3 { color: #1a202c; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.5em; margin-top: 1.5em;}
      p { margin-bottom: 1.2em; } a { color: #2563eb; text-decoration: none; } strong { color: #1a202c; }
      blockquote { border-left: 4px solid #2563eb; background-color: #f0f4ff; padding: 1em 1.5em; margin: 1.5em 0; color: #4a5568; }
      code { background-color: #edf2f7; padding: 0.2em 0.4em; border-radius: 4px; font-family: "Fira Code", monospace; font-size: 0.9em; }
      pre { background-color: #1a202c; color: #e2e8f0; padding: 1.5em; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
      pre code { background-color: transparent; padding: 0; }
      table { width: 100%; border-collapse: collapse; margin: 1.5em 0; }
      th, td { border: 1px solid #e2e8f0; padding: 0.8em 1em; text-align: left; }
      th { background-color: #edf2f7; }
    `;
  }

  async function markdownToPoster(
    markdown: string,
    theme: "light" | "black-gold"
  ): Promise<string> {
    const htmlContent = await marked.parse(markdown);
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${getThemeStyles(
      theme
    )}</style></head><body>${htmlContent}</body></html>`;
  }
}
