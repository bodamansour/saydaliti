// The pharmacy's data in the shape the website uses (src/core.js fromExport): items with batches, and the
// sales, purchases and losses lines the reports read.

class Batch {
  double qty;
  DateTime? expiry;
  double? cost;
  double? price;
  String? lot;
  Batch({required this.qty, this.expiry, this.cost, this.price, this.lot});
  Batch copy() => Batch(qty: qty, expiry: expiry, cost: cost, price: price, lot: lot);
}

class Item {
  String code;
  String name;
  String? en;
  double? strips;
  double? pills;
  String? generic;
  String? maker;
  double? min;
  double? tax;
  String category;
  String owner;
  double cost;
  double price;
  double qty;
  DateTime? expiry;
  List<Batch>? batches;
  String? image;
  double? short; // sold with no stock recorded, while the live stock is worked out

  Item({
    required this.code,
    required this.name,
    this.en,
    this.strips,
    this.pills,
    this.generic,
    this.maker,
    this.min,
    this.tax,
    required this.category,
    required this.owner,
    required this.cost,
    required this.price,
    required this.qty,
    this.expiry,
    this.batches,
    this.image,
  });

  /// `{ ...it }`: a new item sharing the same batch list.
  Item shallow() => Item(
        code: code,
        name: name,
        en: en,
        strips: strips,
        pills: pills,
        generic: generic,
        maker: maker,
        min: min,
        tax: tax,
        category: category,
        owner: owner,
        cost: cost,
        price: price,
        qty: qty,
        expiry: expiry,
        batches: batches,
        image: image,
      );
}

class Sale {
  final DateTime date;
  final String code;
  final double qty;
  final double? price; // the unit price charged, when known
  final double? discount;
  final double? cost; // what one unit cost, when known
  const Sale({required this.date, required this.code, required this.qty, this.price, this.discount, this.cost});
}

class Purchase {
  final DateTime date;
  final String code;
  final double qty;
  final double cost;
  const Purchase({required this.date, required this.code, required this.qty, required this.cost});
}

class Loss {
  final DateTime date;
  final String code;
  final double qty;
  final String reason;
  final double? cost;
  const Loss({required this.date, required this.code, required this.qty, required this.reason, this.cost});
}

class Drawing {
  final String? id;
  final DateTime date;
  final String code;
  final String name;
  final double qty;
  final double value;
  final String? person;
  final String? branchId;
  const Drawing({this.id, required this.date, required this.code, required this.name, required this.qty, required this.value, this.person, this.branchId});
}

class PharmacyData {
  final List<Item> items;
  final List<Sale> sales;
  final List<Purchase> purchases;
  final List<Loss> losses;
  final List<Drawing> drawings;
  PharmacyData({List<Item>? items, List<Sale>? sales, List<Purchase>? purchases, List<Loss>? losses, List<Drawing>? drawings})
      : items = items ?? [],
        sales = sales ?? [],
        purchases = purchases ?? [],
        losses = losses ?? [],
        drawings = drawings ?? [];
}

const unassigned = 'من غير صاحب';
