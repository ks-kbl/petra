/**
 * 唤醒监听（KWS）的暂停闸门。
 *
 * 为什么需要它：唤醒引擎常年占着麦克风，而"暂停唤醒"的动作原本散落在三处
 * （TTS 播报、唤醒回应的本地语音、以后的录音识别），各自直接调
 * `wake_set_paused(false)`。只要有一处先播完就无条件恢复，就会把另一处
 * 还要继续的暂停给拉回来 —— 比如 TTS 还在念，录音刚结束就把唤醒打开了。
 *
 * 这里用一个引用计数式的闸门：谁需要暂停就 hold 一下，用完 release；
 * 只有**所有持有者都释放**了才真正恢复监听。
 */
import { invoke } from "@tauri-apps/api/core";

const holders = new Set<string>();

function apply(): void {
  void invoke("wake_set_paused", { paused: holders.size > 0 }).catch(() => {});
}

/** 申请暂停唤醒监听（同一个 reason 重复调用只会记一次） */
export function holdWake(reason: string): void {
  if (holders.has(reason)) return;
  holders.add(reason);
  apply();
}

/**
 * 释放暂停。
 * @param delayMs 延迟恢复，默认 300ms：躲开语音尾音/混响，否则刚说完就把自己再唤醒
 */
export function releaseWake(reason: string, delayMs = 300): void {
  if (!holders.has(reason)) return;
  const finish = () => {
    holders.delete(reason);
    apply();
  };
  if (delayMs <= 0) finish();
  else window.setTimeout(finish, delayMs);
}

/** 现在有没有人正占着（排障/单测用） */
export function wakeHeld(): boolean {
  return holders.size > 0;
}
