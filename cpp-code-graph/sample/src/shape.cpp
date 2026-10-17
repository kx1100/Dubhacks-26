#include "geo/shape.h"
#include "geo/canvas.h"
#include <cmath>

namespace geo {

Shape::Shape(std::string name) : name_(std::move(name)) {}

void Shape::draw(Canvas& canvas) const {
    canvas.plot(static_cast<int>(origin_.x), static_cast<int>(origin_.y));
}

Circle::Circle(Point c, double r) : Shape("circle"), radius_(r) {
    origin_ = c;
}

double Circle::area() const {
    return M_PI * radius_ * radius_;
}

void Circle::draw(Canvas& canvas) const {
    for (int i = 0; i < 360; ++i) {
        double a = i * M_PI / 180.0;
        canvas.plot(int(origin_.x + std::cos(a) * radius_), int(origin_.y + std::sin(a) * radius_));
    }
}

std::unique_ptr<Shape> makeShape(const std::string& kind) {
    if (kind == "circle") return std::make_unique<Circle>(Point{0, 0}, 1.0);
    return std::make_unique<Rectangle>(Point{0, 0}, 1.0, 1.0);
}

} // namespace geo
