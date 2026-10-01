#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen-icons.py —— 生成 PWA 应用图标（192 / 512），零第三方依赖。

为什么不用 Pillow：本项目刻意保持「零运行时依赖」，图标属于一次性产物，
   用纯 Python 手写 PNG 编码器即可（zlib + struct 均为标准库），
   顺带避免了给工程引入构建期依赖。

绘制内容：圆角方形渐变底（粉 → 深粉）+ 居中白色心形。
心形使用经典隐式方程 (x^2 + y^2 - 1)^3 - x^2 * y^3 <= 0，
配合 4 倍超采样做抗锯齿，边缘平滑无锯齿。

用法：python scripts/gen-icons.py
"""

import math
import os
import struct
import zlib

# ---------------------------------------------------------------- 参数
SS = 4                      # 超采样倍数（抗锯齿）
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icons')

BG_TOP = (255, 118, 118)    # 渐变起始色
BG_BOTTOM = (206, 48, 116)  # 渐变结束色
HEART = (255, 255, 255)     # 心形颜色
CORNER_RATIO = 0.22         # 圆角半径占边长比例
HEART_SCALE = 0.62          # 心形宽度占图标边长比例


def inside_heart(x, y):
    """标准隐式心形方程；x、y 已归一化到心形自身坐标系"""
    a = x * x + y * y - 1.0
    return a * a * a - x * x * y * y * y <= 0.0


def render(size):
    """渲染一张 size x size 的 RGBA 图标，返回 bytes"""
    big = size * SS
    inv = 1.0 / SS

    # 圆角半径（大图坐标系）
    r = CORNER_RATIO * big

    # 心形在归一化坐标下的竖直范围约为 [-0.62, 1.0]，
    # 由此换算像素缩放，使心形视觉居中
    heart_half_w = HEART_SCALE * big * 0.5

    # 累加缓冲区（超采样求和，最后除以 SS^2）
    acc_r = [0] * (size * size)
    acc_g = [0] * (size * size)
    acc_b = [0] * (size * size)
    acc_a = [0] * (size * size)

    for by in range(big):
        # 圆角方形遮罩：逐行预计算左右边界，减少内层判断
        cy = by + 0.5
        for bx in range(big):
            cx = bx + 0.5

            # ---- 圆角矩形覆盖判定 ----
            in_rect = True
            # 四个角的圆形区域外判定
            if cx < r and cy < r:
                in_rect = (cx - r) ** 2 + (cy - r) ** 2 <= r * r
            elif cx > big - r and cy < r:
                in_rect = (cx - (big - r)) ** 2 + (cy - r) ** 2 <= r * r
            elif cx < r and cy > big - r:
                in_rect = (cx - r) ** 2 + (cy - (big - r)) ** 2 <= r * r
            elif cx > big - r and cy > big - r:
                in_rect = (cx - (big - r)) ** 2 + (cy - (big - r)) ** 2 <= r * r

            if not in_rect:
                continue

            # ---- 渐变底色 ----
            t = cy / big
            bg = (
                int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
                int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
                int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
            )

            color = bg

            # ---- 心形判定（图像 y 轴向下，需翻转）----
            hx = (cx - big * 0.5) / heart_half_w
            hy = -(cy - big * 0.5) / (heart_half_w * 1.08) + 0.16
            if inside_heart(hx, hy):
                color = HEART

            # ---- 累加到目标像素 ----
            px = int(cx * inv)
            py = int(cy * inv)
            if px >= size:
                px = size - 1
            if py >= size:
                py = size - 1
            idx = py * size + px
            acc_r[idx] += color[0]
            acc_g[idx] += color[1]
            acc_b[idx] += color[2]
            acc_a[idx] += 255

    # ---- 归一化 + 组装 RGBA 行数据 ----
    total = SS * SS
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # PNG 行过滤器类型 0（None）
        for x in range(size):
            idx = y * size + x
            cover = acc_a[idx] / total          # 实际覆盖率 0~255
            if cover <= 0:
                raw += b'\x00\x00\x00\x00'
                continue
            # 颜色按覆盖率归一（避免边缘因平均而发暗）
            n = acc_a[idx] / 255.0
            raw.append(int(acc_r[idx] / n + 0.5))
            raw.append(int(acc_g[idx] / n + 0.5))
            raw.append(int(acc_b[idx] / n + 0.5))
            raw.append(int(cover + 0.5))

    return bytes(raw), size


def write_png(path, raw, size):
    """把原始 RGBA 行数据编码成 PNG 文件"""
    def chunk(tag, data):
        out = struct.pack('>I', len(data)) + tag + data
        out += struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (192, 512):
        raw, s = render(size)
        target = os.path.normpath(os.path.join(OUT_DIR, 'icon-%d.png' % size))
        written = write_png(target, raw, s)
        print('已生成 %s  (%dx%d, %.1f KB)' % (target, s, s, written / 1024.0))


if __name__ == '__main__':
    main()
