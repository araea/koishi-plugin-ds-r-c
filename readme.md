# koishi-plugin-ds-r-c

[<img alt="github" src="https://img.shields.io/badge/github-araea/ds_r_c-8da0cb?style=for-the-badge&labelColor=555555&logo=github" height="20">](https://github.com/araea/koishi-plugin-ds-r-c)
[<img alt="npm" src="https://img.shields.io/npm/v/koishi-plugin-ds-r-c.svg?style=for-the-badge&color=fc8d62&logo=npm" height="20">](https://www.npmjs.com/package/koishi-plugin-ds-r-c)

Koishi 的 DeepSeek AI 聊天插件。

## 使用

1. 启动 `pptr` 和 `数据库` 服务。
2. 设置指令别名（若没看到指令，请重启 commands 插件）。
3. 填写配置（若是第三方 API，baseURL 最后别忘了加上 /v1）。
4. 发送 `dsrc 创建房间`。
5. 发送 `房间名 文本` 聊天。

## 特性

* 引用回复 `房间` 最后一条响应，可：
  * 触发 `删除某个房间的全部聊天记录`, `重新回复` 操作该 `房间`。
  * 消息结尾增加两个及以上空格，可直接继续聊天。

## 致谢

* [Koishi](https://koishi.chat/)
* [DeepSeek AI](https://deepseek.ai/)

## QQ 群

* 956758505

<br>

#### License

<sup>
Licensed under either of <a href="LICENSE-APACHE">Apache License, Version
2.0</a> or <a href="LICENSE-MIT">MIT license</a> at your option.
</sup>

<br>

<sub>
Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this crate by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.
</sub>

