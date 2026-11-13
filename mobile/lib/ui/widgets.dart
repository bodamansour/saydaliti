// Small pieces every screen shares: the pharmacy cross, number tiles, pills, empty and error states.
import 'package:flutter/material.dart';

import 'theme.dart';

/// The logo: four tablets on the blue gradient, like the website's mark.
class Mark extends StatelessWidget {
  const Mark({super.key, this.size = 40, this.onHero = false});
  final double size;

  /// On the gradient the mark turns over: a white square with blue tablets.
  final bool onHero;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: onHero ? Colors.white : null, gradient: onHero ? null : t.hero, borderRadius: BorderRadius.circular(size * .28)),
      child: CustomPaint(painter: _Cross(onHero ? const Color(0xFF1746D1) : Colors.white)),
    );
  }
}

class _Cross extends CustomPainter {
  _Cross(this.color);
  final Color color;

  /// The logo: four tablets in a blister, the last one tinted (the same drawing as the website's mark and the icon).
  @override
  void paint(Canvas c, Size s) {
    final white = color == Colors.white;
    final tint = white ? const Color(0xFFBFE9F5) : const Color(0xFF06B6D4);
    final r = s.width * .13;
    for (final (dx, dy, last) in [(.34, .34, false), (.66, .34, false), (.34, .66, false), (.66, .66, true)]) {
      c.drawCircle(Offset(s.width * dx, s.height * dy), r, Paint()..color = last ? tint : color);
    }
  }

  @override
  bool shouldRepaint(_Cross o) => o.color != color;
}

/// The gradient card: for the one number that matters most on a screen.
class HeroCard extends StatelessWidget {
  const HeroCard({super.key, required this.child, this.onTap});
  final Widget child;
  final VoidCallback? onTap;
  static const fg = Colors.white;
  static const muted = Color(0xD6FFFFFF);
  @override
  Widget build(BuildContext context) => Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: Ink(
          decoration: BoxDecoration(gradient: context.tones.hero),
          child: InkWell(onTap: onTap, child: Padding(padding: const EdgeInsets.fromLTRB(18, 16, 18, 18), child: child)),
        ),
      );
}

/// A number that counts up to its value when it first shows or changes.
class CountUp extends StatelessWidget {
  const CountUp(this.value, {super.key, required this.format, this.style});
  final double value;
  final String Function(double) format;
  final TextStyle? style;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(end: value),
        duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 600),
        curve: Curves.easeOutCubic,
        builder: (_, v, __) => Text(format(v), style: style),
      );
}

enum Tone { plain, good, warn, crit, info }

extension ToneColors on Tone {
  (Color fg, Color bg) colors(Tones t) => switch (this) {
        Tone.good => (t.accentStrong, t.accentSoft),
        Tone.warn => (t.warn, t.warnSoft),
        Tone.crit => (t.crit, t.critSoft),
        Tone.info => (t.info, t.infoSoft),
        Tone.plain => (t.muted, t.sunk),
      };
}

class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.tone = Tone.plain});
  final String text;
  final Tone tone;
  @override
  Widget build(BuildContext context) {
    final (fg, bg) = tone.colors(context.tones);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w600)),
    );
  }
}

/// A number with its label, and a line under it.
class Tile extends StatelessWidget {
  const Tile({super.key, required this.label, required this.value, this.note, this.tone = Tone.plain, this.onTap, this.big = false});
  final String label, value;
  final String? note;
  final Tone tone;
  final VoidCallback? onTap;
  final bool big;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    final (fg, _) = tone.colors(t);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(children: [
                Container(width: 3, height: 14, decoration: BoxDecoration(color: tone == Tone.plain ? t.line : fg, borderRadius: BorderRadius.circular(2))),
                const SizedBox(width: 7),
                Expanded(child: Text(label, style: TextStyle(color: t.muted, fontSize: 13), maxLines: 2, overflow: TextOverflow.ellipsis)),
              ]),
              const SizedBox(height: 6),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: AlignmentDirectional.centerStart,
                child: Text(value,
                    style: TextStyle(fontSize: big ? 30 : 22, fontWeight: FontWeight.w600, color: tone == Tone.plain || tone == Tone.good ? t.fg : fg, height: 1.25),
                    textDirection: TextDirection.rtl),
              ),
              if (note != null) ...[
                const SizedBox(height: 4),
                Text(note!, style: TextStyle(color: t.faint, fontSize: 12.5), maxLines: 2, overflow: TextOverflow.ellipsis),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Two tiles side by side.
class TileRow extends StatelessWidget {
  const TileRow(this.children, {super.key});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(width: 10), Expanded(child: children[i])],
        ]),
      );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});
  final String text;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(2, 18, 2, 8),
        child: Row(children: [Expanded(child: Text(text, style: Theme.of(context).textTheme.titleLarge)), if (trailing != null) trailing!]),
      );
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.text, this.icon = Icons.inbox_outlined, this.action});
  final String title;
  final String? text;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 44, color: t.faint),
        const SizedBox(height: 12),
        Text(title, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
        if (text != null) ...[const SizedBox(height: 6), Text(text!, style: TextStyle(color: t.muted), textAlign: TextAlign.center)],
        if (action != null) ...[const SizedBox(height: 16), action!],
      ]),
    );
  }
}

class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.tone = Tone.crit, this.action});
  final String text;
  final Tone tone;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final (fg, bg) = tone.colors(context.tones);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Expanded(child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w500))),
        if (action != null) action!,
      ]),
    );
  }
}

/// One line of a money breakdown: label on the start side, amount on the end side.
class AmountLine extends StatelessWidget {
  const AmountLine(this.label, this.amount, {super.key, this.sign = '', this.strong = false, this.muted = false});
  final String label, amount, sign;
  final bool strong, muted;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    final style = TextStyle(fontSize: strong ? 17 : 15, fontWeight: strong ? FontWeight.w600 : FontWeight.w400, color: muted ? t.muted : t.fg);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      // A long value wraps under itself instead of pushing past the edge of a narrow phone.
      child: LayoutBuilder(
        builder: (context, box) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Text(label, style: style)),
          const SizedBox(width: 12),
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: box.maxWidth * .6),
            child: Text('$sign$amount', style: style, textDirection: TextDirection.rtl, textAlign: TextAlign.end),
          ),
        ]),
      ),
    );
  }
}

/// A scrollable page that refreshes when pulled down.
class RefreshPage extends StatelessWidget {
  const RefreshPage({super.key, required this.onRefresh, required this.children, this.bottom = 28});
  final Future<void> Function() onRefresh;
  final List<Widget> children;

  /// Room under the last card (more when a floating button sits over the list).
  final double bottom;
  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: onRefresh,
        child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: EdgeInsets.fromLTRB(16, 12, 16, bottom), children: children),
      );
}
